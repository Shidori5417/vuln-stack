import pLimit from 'p-limit';
import { mergeRecords } from './advisories/merge.js';
import { severityFromScore } from './advisories/cvss.js';
import { GhsaClient, ghsaCacheKey } from './advisories/ghsa.js';
import { enrichExploit, enrichExploitOffline, type ExploitSource } from './advisories/exploit.js';
import { NvdClient, type NvdOptions } from './advisories/nvd.js';
import {
  OsvClient,
  type OsvClientOptions,
  type OsvRecord,
  type PackageQuery,
} from './advisories/osv.js';
import { MemoryCache } from './cache/memory.js';
import type { CacheStore } from './cache/types.js';
import { defaultPlugins, pluginFor } from './ecosystems/registry.js';
import type { EcosystemPlugin } from './ecosystems/types.js';
import { chainNames, computePaths, nodeId } from './model/graph.js';
import {
  SEVERITY_ORDER,
  type Dependency,
  type DependencyGraph,
  type Finding,
  type ScanResult,
  type ScanSummary,
  type Subproject,
  type Vulnerability,
  type Warning,
} from './model/types.js';
import type { FetchFn, NetContext } from './net/context.js';
import { computeRemediation, recordAffects } from './remediation.js';
import { collectSubprojects } from './sources/discover.js';
import type { FileProvider } from './sources/file-provider.js';
import { manualSubprojects, parseManualInput } from './sources/manual.js';
import { VERSION } from './version.js';

export type ScanPhase = 'parse' | 'resolve' | 'query' | 'details' | 'enrich' | 'done';

export interface ScanOptions {
  fetch?: FetchFn;
  cache?: CacheStore;
  plugins?: readonly EcosystemPlugin[];
  userAgent?: string;
  signal?: AbortSignal;
  /** Resolve manifest ranges against the package registry (default true). */
  resolveRanges?: boolean;
  /** Include dev dependencies (default true). */
  includeDev?: boolean;
  osv?: OsvClientOptions;
  /**
   * Answer from a local OSV database instead of the network: no OSV / GHSA / NVD
   * calls and no registry range resolution.
   */
  offline?: {
    query(ecosystem: string, name: string, version: string): OsvRecord[] | Promise<OsvRecord[]>;
    /** Warnings collected while querying (e.g. an ecosystem index that is missing); read after all queries. */
    warnings?(): Warning[];
    /** Build time per ecosystem, shown in the offline-mode warning. */
    builtAt?: Record<string, string>;
    /** Local KEV / EPSS data (see `loadExploitData` in `@vulnstack/core/node`). */
    exploit?: ExploitSource;
  };
  /** Also query the GitHub Advisory Database (needs a GitHub token, no scopes). */
  ghsa?: { token: string; endpoint?: string };
  /** Enrich CVSS scores from NVD. Without an API key only ~5 CVEs per 30 s are fetched. */
  nvd?: NvdOptions;
  /** Mark CVEs in CISA's Known Exploited Vulnerabilities catalog (default true; offline: needs `offline.exploit`). */
  kev?: boolean;
  /** Add FIRST EPSS exploit-probability scores (default true; offline: needs `offline.exploit`). */
  epss?: boolean;
  onProgress?: (phase: ScanPhase, detail?: string) => void;
}

const RESOLVE_CONCURRENCY = 8;

function netContext(options: ScanOptions): NetContext {
  const net: NetContext = {
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    cache: options.cache ?? new MemoryCache(),
    userAgent:
      options.userAgent ?? `vulnstack/${VERSION} (+https://github.com/Shidori5417/vuln-stack)`,
  };
  if (options.signal) net.signal = options.signal;
  return net;
}

/** Node ids embed the version, so they must be rebuilt after ranges are resolved. */
function rekeyGraph(graph: DependencyGraph): void {
  const remap = new Map<string, string>();
  const nodes = new Map<string, Dependency>();
  for (const [oldId, dep] of graph.nodes) {
    const id = nodeId(dep);
    remap.set(oldId, id);
    const existing = nodes.get(id);
    if (existing) existing.isDirect ||= dep.isDirect;
    else nodes.set(id, dep);
  }
  const edges = new Map<string, Set<string>>();
  for (const [from, children] of graph.edges) {
    const key = remap.get(from) ?? from;
    const set = edges.get(key) ?? new Set();
    for (const c of children) {
      const mapped = remap.get(c);
      if (mapped) set.add(mapped);
    }
    edges.set(key, set);
  }
  graph.nodes = nodes;
  graph.edges = edges;
}

function dropNode(graph: DependencyGraph, id: string): void {
  graph.nodes.delete(id);
  graph.edges.delete(id);
  for (const children of graph.edges.values()) children.delete(id);
}

async function resolveVersions(
  subprojects: Subproject[],
  plugins: readonly EcosystemPlugin[],
  net: NetContext,
  enabled: boolean,
  warnings: Warning[],
): Promise<void> {
  const limit = pLimit(RESOLVE_CONCURRENCY);
  const memo = new Map<string, Promise<string | null>>();

  for (const sub of subprojects) {
    const plugin = pluginFor(sub.ecosystem, plugins);
    const unresolved = [...sub.graph.nodes.entries()].filter(([, d]) => !d.version && !d.internal);
    if (unresolved.length === 0) continue;

    await Promise.all(
      unresolved.map(([id, dep]) =>
        limit(async () => {
          const range = dep.declaredRange ?? '*';
          let version: string | null = null;
          if (enabled && plugin?.resolveRange) {
            const key = `${dep.ecosystem}:${dep.name}:${range}`;
            let pending = memo.get(key);
            if (!pending) {
              pending = plugin.resolveRange(dep.name, range, net).catch(() => null);
              memo.set(key, pending);
            }
            version = await pending;
          }
          if (version) {
            dep.version = version;
          } else {
            warnings.push({
              code: 'unresolved-version',
              message: `Could not resolve ${dep.name}@${range}; it was not scanned`,
              file: dep.sourceFile,
            });
            dropNode(sub.graph, id);
          }
        }),
      ),
    );
    rekeyGraph(sub.graph);
  }
}

const depKey = (d: Pick<Dependency, 'ecosystem' | 'name' | 'version'>) =>
  `${d.ecosystem}:${d.name}@${d.version}`;

export function fingerprintOf(subproject: string, dep: Dependency, vulnId: string): string {
  return [subproject || '.', dep.ecosystem, dep.name, vulnId].join('|');
}

export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_ORDER.indexOf(a.vulnerability.severity) -
      SEVERITY_ORDER.indexOf(b.vulnerability.severity) ||
    (b.vulnerability.cvss?.score ?? 0) - (a.vulnerability.cvss?.score ?? 0) ||
    Number(b.dependency.isDirect) - Number(a.dependency.isDirect) ||
    a.dependency.name.localeCompare(b.dependency.name) ||
    a.vulnerability.id.localeCompare(b.vulnerability.id)
  );
}

export function summarize(subprojects: Subproject[], findings: Finding[]): ScanSummary {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const f of findings) bySeverity[f.vulnerability.severity]++;
  return {
    subprojects: subprojects.length,
    dependencies: subprojects.reduce(
      (n, s) => n + [...s.graph.nodes.values()].filter((d) => !d.internal).length,
      0,
    ),
    vulnerableDependencies: new Set(findings.map((f) => `${f.subproject}|${depKey(f.dependency)}`))
      .size,
    findings: findings.length,
    bySeverity,
  };
}

async function queryGhsa(
  queries: PackageQuery[],
  config: NonNullable<ScanOptions['ghsa']>,
  net: NetContext,
  warnings: Warning[],
): Promise<Map<string, OsvRecord[]> | undefined> {
  const client = new GhsaClient(net, config.token, config.endpoint);
  // Go's stdlib is not a GHSA package.
  const packages = queries.filter((q) => !(q.ecosystem === 'Go' && q.name === 'stdlib'));
  try {
    return await client.query(packages.map((q) => ({ ecosystem: q.ecosystem, name: q.name })));
  } catch (error) {
    warnings.push({
      code: 'ghsa-failed',
      message: `GitHub Advisory Database unavailable: ${(error as Error).message}`,
    });
    return undefined;
  }
}

/**
 * Replaces scores with NVD's where available (NVD > GHSA > OSV). Most severe
 * CVEs go first so a limited budget is spent where it matters.
 */
async function enrichFromNvd(
  vulns: Vulnerability[],
  options: NvdOptions,
  net: NetContext,
  warnings: Warning[],
) {
  const cveOf = (v: Vulnerability) => v.aliases.find((a) => a.startsWith('CVE-'));
  const ordered = [...vulns].sort((a, b) => (b.cvss?.score ?? 0) - (a.cvss?.score ?? 0));
  const cves = ordered.map(cveOf).filter((c): c is string => c !== undefined);
  if (cves.length === 0) return;
  try {
    const { entries, skipped } = await new NvdClient(net, options).lookup(cves);
    for (const vuln of vulns) {
      const entry = entries.get(cveOf(vuln) ?? '');
      if (!entry) continue;
      if (entry.cvss) {
        vuln.cvss = entry.cvss;
        vuln.severity = severityFromScore(entry.cvss.score);
      }
      if (!vuln.summary && entry.description) vuln.summary = entry.description.split('\n')[0]!;
    }
    if (skipped.length) {
      warnings.push({
        code: 'nvd-partial',
        message: `NVD scores were fetched for ${entries.size} of ${entries.size + skipped.length} CVEs (rate limit); the rest use GHSA/OSV scores. Set NVD_API_KEY for faster enrichment.`,
      });
    }
  } catch (error) {
    warnings.push({ code: 'nvd-failed', message: `NVD unavailable: ${(error as Error).message}` });
  }
}

/** Scans already-parsed subprojects against OSV (and GHSA / NVD when configured). */
export async function scanSubprojects(
  subprojects: Subproject[],
  options: ScanOptions = {},
  initialWarnings: Warning[] = [],
): Promise<ScanResult> {
  const started = Date.now();
  const plugins = options.plugins ?? defaultPlugins;
  const net = netContext(options);
  const warnings = [...initialWarnings];

  if (options.includeDev === false) {
    for (const sub of subprojects) {
      for (const [id, dep] of [...sub.graph.nodes])
        if (dep.scope === 'dev') dropNode(sub.graph, id);
    }
  }

  const offline = options.offline;
  if (offline) {
    const dates = Object.entries(offline.builtAt ?? {})
      .map(([eco, at]) => `${eco}: ${at}`)
      .join(', ');
    warnings.push({
      code: 'offline-mode',
      message: `Offline mode: advisory data is local${dates ? ` (as of ${dates})` : ''}; unresolved manifest ranges are not scanned. Run "vulnstack db update" to refresh.`,
    });
  }

  options.onProgress?.('resolve');
  await resolveVersions(
    subprojects,
    plugins,
    net,
    offline ? false : (options.resolveRanges ?? true),
    warnings,
  );

  const unique = new Map<string, PackageQuery>();
  for (const sub of subprojects) {
    for (const dep of sub.graph.nodes.values()) {
      if (dep.internal) continue;
      unique.set(depKey(dep), { ecosystem: dep.ecosystem, name: dep.name, version: dep.version });
    }
  }

  const queryOnline = async (queries: PackageQuery[], vulnsByDep: Map<string, Vulnerability[]>) => {
    const osv = new OsvClient(net, options.osv);
    options.onProgress?.('query', `${unique.size} packages`);
    const idLists = await osv.queryIds(queries);

    options.onProgress?.('details');
    const records = await osv.getVulns(idLists.flat());
    const ghsaRecords = options.ghsa
      ? await queryGhsa(queries, options.ghsa, net, warnings)
      : undefined;

    queries.forEach((q, i) => {
      const recs: OsvRecord[] = idLists[i]!.map((id) => records.get(id)).filter(
        (r) => r !== undefined,
      );
      const plugin = pluginFor(q.ecosystem, plugins);
      for (const r of ghsaRecords?.get(ghsaCacheKey(q)) ?? []) {
        if (
          plugin &&
          recordAffects(
            r.affected ?? [],
            q.ecosystem,
            q.name,
            q.version,
            plugin.versioning,
            plugin.normalizeName,
          )
        ) {
          recs.push(r);
        }
      }
      if (recs.length > 0) vulnsByDep.set(depKey(q), mergeRecords(recs));
    });
  };

  const vulnsByDep = new Map<string, Vulnerability[]>();
  const queries = [...unique.values()];
  if (offline) {
    options.onProgress?.('query', `${unique.size} packages`);
    for (const q of queries) {
      const recs = await offline.query(q.ecosystem, q.name, q.version);
      if (recs.length > 0) vulnsByDep.set(depKey(q), mergeRecords(recs));
    }
    warnings.push(...(offline.warnings?.() ?? []));
  } else {
    await queryOnline(queries, vulnsByDep);
  }

  if (options.nvd && !offline) {
    options.onProgress?.('enrich');
    await enrichFromNvd([...vulnsByDep.values()].flat(), options.nvd, net, warnings);
  }

  const toggles = { kev: options.kev !== false, epss: options.epss !== false };
  if (toggles.kev || toggles.epss) {
    const all = [...vulnsByDep.values()].flat();
    if (!offline) await enrichExploit(all, toggles, net, warnings);
    else if (offline.exploit) enrichExploitOffline(all, offline.exploit, toggles, warnings);
  }

  const findings: Finding[] = [];
  for (const sub of subprojects) {
    const plugin = pluginFor(sub.ecosystem, plugins);
    const paths = computePaths(sub.graph);
    for (const [id, dep] of sub.graph.nodes) {
      if (dep.internal) continue;
      const vulns = vulnsByDep.get(depKey(dep));
      if (!vulns) continue;
      const pathInfo = paths.get(id) ?? { path: [id], pathCount: 1 };
      for (const vuln of vulns) {
        findings.push({
          fingerprint: fingerprintOf(sub.path, dep, vuln.id),
          subproject: sub.path,
          dependency: dep,
          chain: chainNames(sub.graph, pathInfo.path),
          pathCount: pathInfo.pathCount,
          vulnerability: vuln,
          remediation: plugin
            ? computeRemediation(dep, vuln, plugin.versioning, plugin.normalizeName)
            : { type: 'no-fix' },
        });
      }
    }
  }
  findings.sort(compareFindings);

  for (const sub of subprojects) warnings.push(...sub.warnings);
  options.onProgress?.('done');

  return {
    schemaVersion: 1,
    tool: { name: 'vulnstack', version: VERSION },
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    subprojects,
    findings,
    summary: summarize(subprojects, findings),
    warnings,
  };
}

/** Discovers and parses dependency files from any FileProvider, then scans. */
export async function scanFiles(
  provider: FileProvider,
  options: ScanOptions = {},
): Promise<ScanResult> {
  options.onProgress?.('parse');
  const { subprojects, warnings } = await collectSubprojects(
    provider,
    options.plugins ?? defaultPlugins,
  );
  return scanSubprojects(subprojects, options, warnings);
}

/** Scans free-text input such as "react@18.2.0, express 4.17.1". */
export async function scanManual(text: string, options: ScanOptions = {}): Promise<ScanResult> {
  const { entries, errors } = parseManualInput(text);
  const warnings: Warning[] = errors.map((e) => ({
    code: 'manual-parse-error',
    message: e.message,
  }));
  return scanSubprojects(manualSubprojects(entries), options, warnings);
}
