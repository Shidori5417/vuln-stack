import semver from 'semver';
import { parse as parseToml } from 'smol-toml';
import { DEFAULT_TTL_SECONDS } from '../../cache/types.js';
import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, Subproject, Warning } from '../../model/types.js';
import { fetchJson } from '../../net/http.js';
import { basename, joinPath, type FileProvider } from '../../sources/file-provider.js';
import { SUPPORTED_FILES } from '../files.js';
import { parseSemver, propagateScopes, rootIds, semverVersioning } from '../shared.js';
import type { EcosystemPlugin } from '../types.js';

interface LockPackage {
  name?: unknown;
  version?: unknown;
  source?: unknown;
  dependencies?: unknown;
}

type DepTable = Record<string, unknown>;

export interface CargoManifest {
  package?: { name?: string };
  dependencies?: DepTable;
  'build-dependencies'?: DepTable;
  'dev-dependencies'?: DepTable;
  workspace?: { members?: string[] };
}

const REGISTRY_SOURCE =
  /^(registry|sparse)\+https:\/\/(github\.com\/rust-lang\/crates\.io-index|index\.crates\.io\/)/;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function readToml<T>(content: string): T | undefined {
  try {
    return parseToml(content) as T;
  } catch {
    return undefined;
  }
}

/** Names declared under [dependencies]/[build-dependencies] (prod) and [dev-dependencies] only (dev). */
function devOnlyNames(manifest: CargoManifest | undefined): Set<string> {
  const rename = (table: DepTable | undefined) =>
    Object.entries(table ?? {}).map(([key, v]) =>
      v && typeof v === 'object' && 'package' in v ? String((v as DepTable).package) : key,
    );
  const prod = new Set([
    ...rename(manifest?.dependencies),
    ...rename(manifest?.['build-dependencies']),
  ]);
  return new Set(rename(manifest?.['dev-dependencies']).filter((n) => !prod.has(n)));
}

/**
 * Cargo.lock: `[[package]]` tables with `dependencies = ["name", "name ver", "name ver (source)"]`.
 * Packages without a `source` are workspace members or path dependencies (internal);
 * their registry dependencies are the direct ones. Git and alternative registries are
 * skipped with a warning but kept as internal nodes so chains stay intact.
 */
export function parseCargoLock(
  content: string,
  sourceFile: string,
  rootName: string,
  manifest?: CargoManifest,
): { graph: DependencyGraph; warnings: Warning[] } {
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  const lock = readToml<{ package?: LockPackage[] }>(content);
  if (!lock) {
    warnings.push({
      code: 'malformed-lockfile',
      message: `${sourceFile}: not valid TOML`,
      file: sourceFile,
    });
    return { graph, warnings };
  }

  interface Entry {
    id: string;
    name: string;
    version: string;
    internal: boolean;
    deps: string[];
  }
  const entries: Entry[] = [];
  const byName = new Map<string, Entry[]>();
  for (const pkg of Array.isArray(lock.package) ? lock.package : []) {
    const name = str(pkg?.name);
    const version = str(pkg?.version);
    if (!name || !version) continue;
    const source = str(pkg.source);
    const registry = source !== undefined && REGISTRY_SOURCE.test(source);
    const internal = !registry;
    if (source && !registry) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${name}: source ${source.split('#')[0]} is not crates.io`,
        file: sourceFile,
      });
    }
    const id = addNode(graph, {
      ecosystem: 'crates.io',
      name,
      version,
      isDirect: false,
      sourceFile,
      confidence: 'high',
      scope: 'prod',
      ...(internal ? { internal: true } : {}),
    });
    const entry: Entry = {
      id,
      name,
      version,
      internal,
      deps: Array.isArray(pkg.dependencies)
        ? pkg.dependencies.filter((d) => typeof d === 'string')
        : [],
    };
    entries.push(entry);
    byName.set(name, [...(byName.get(name) ?? []), entry]);
  }

  const resolve = (spec: string): Entry[] => {
    const [name, version] = spec.split(' ');
    const candidates = byName.get(name ?? '') ?? [];
    return version ? candidates.filter((c) => c.version === version) : candidates;
  };

  for (const entry of entries) {
    for (const dep of entry.deps) {
      for (const target of resolve(dep)) addEdge(graph, entry.id, target.id);
    }
  }

  // Direct = registry dependencies of workspace members (packages without a source).
  const members = entries.filter((e) => e.internal);
  const direct = new Set<string>();
  for (const member of members) {
    for (const dep of member.deps) {
      for (const target of resolve(dep)) if (!target.internal) direct.add(target.id);
    }
  }
  const directIds = direct.size
    ? [...direct]
    : rootIds(
        graph,
        entries.filter((e) => !e.internal).map((e) => e.id),
      );
  const devNames = devOnlyNames(manifest);
  for (const id of directIds) {
    const node = graph.nodes.get(id)!;
    node.isDirect = true;
    if (devNames.has(node.name)) node.scope = 'dev';
    addEdge(graph, ROOT_ID, id);
  }
  if (devNames.size) propagateScopes(graph);
  return { graph, warnings };
}

/** Cargo.toml fallback: requirement strings only, resolved later through resolveRange. */
export function cargoManifestGraph(
  manifest: CargoManifest,
  sourceFile: string,
  rootName: string,
): { graph: DependencyGraph; warnings: Warning[] } {
  const graph = createGraph(manifest.package?.name ?? rootName);
  const warnings: Warning[] = [];
  for (const [table, scope] of [
    [manifest.dependencies, 'prod'],
    [manifest['build-dependencies'], 'prod'],
    [manifest['dev-dependencies'], 'dev'],
  ] as const) {
    for (const [key, spec] of Object.entries(table ?? {})) {
      const obj = spec && typeof spec === 'object' ? (spec as DepTable) : undefined;
      const name = str(obj?.package) ?? key;
      const range = typeof spec === 'string' ? spec : str(obj?.version);
      if (!range || obj?.git || obj?.path) {
        warnings.push({
          code: 'non-registry-version',
          message: `Skipping ${name}: ${range ? 'git or path dependency' : 'no version requirement (workspace, git or path)'}`,
          file: sourceFile,
        });
        continue;
      }
      const id = addNode(graph, {
        ecosystem: 'crates.io',
        name,
        version: '',
        declaredRange: range,
        isDirect: true,
        sourceFile,
        confidence: 'medium',
        scope,
      });
      addEdge(graph, ROOT_ID, id);
    }
  }
  warnings.push({
    code: 'no-lockfile',
    message:
      'No Cargo.lock found; versions are resolved from Cargo.toml requirements and may differ from what is built. Transitive dependencies are not scanned.',
    file: sourceFile,
  });
  return { graph, warnings };
}

/** Cargo requirement (bare `1.2` means `^1.2`, commas mean AND) → semver range. */
function toSemverRange(req: string): string | null {
  const parts = req
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const converted = parts.map((p) => (/^\d/.test(p) ? `^${p}` : p));
  const range = converted.join(' ');
  return semver.validRange(range) ? range : null;
}

export const cargoPlugin: EcosystemPlugin = {
  id: 'crates.io',
  displayName: 'Cargo (crates.io)',
  files: SUPPORTED_FILES['crates.io'],
  versioning: semverVersioning,

  async parse({ dir, files, provider }) {
    const names = new Set(files.map(basename));
    const manifestPath = joinPath(dir, 'Cargo.toml');
    const manifest = names.has('Cargo.toml')
      ? readToml<CargoManifest>(await provider.read(manifestPath))
      : undefined;
    const rootName = manifest?.package?.name ?? (dir ? basename(dir) : 'root');
    let result;
    if (names.has('Cargo.lock')) {
      const lockPath = joinPath(dir, 'Cargo.lock');
      result = parseCargoLock(await provider.read(lockPath), lockPath, rootName, manifest);
    } else if (manifest) {
      result = cargoManifestGraph(manifest, manifestPath, rootName);
    } else {
      return { subprojects: [], warnings: [] };
    }
    const sub: Subproject = { path: dir, ecosystem: 'crates.io', ...result };
    return { subprojects: [sub], warnings: [] };
  },

  async resolveRange(name, range, net) {
    const semverRange = toSemverRange(range);
    if (!semverRange) return null;
    const key = `crates:versions:${name}`;
    let versions = await net.cache.get<string[]>(key);
    if (!versions) {
      const data = await fetchJson<{ versions?: { num: string; yanked?: boolean }[] }>(
        net.fetch,
        `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/versions`,
        { headers: { 'user-agent': net.userAgent } },
        net.signal ? { signal: net.signal } : {},
      );
      versions = (data.versions ?? []).filter((v) => !v.yanked).map((v) => v.num);
      await net.cache.set(key, versions, DEFAULT_TTL_SECONDS);
    }
    const valid = versions.filter((v) => parseSemver(v));
    return semver.maxSatisfying(valid, semverRange) ?? null;
  },

  async isCoveredByLock(lockDir: string, memberDir: string, provider: FileProvider) {
    const lock = await provider.read(joinPath(lockDir, 'Cargo.lock'));
    const manifest = readToml<CargoManifest>(
      await provider.read(joinPath(memberDir, 'Cargo.toml')),
    );
    const name = manifest?.package?.name;
    if (!name) return false;
    return lock.includes(`name = "${name}"`);
  },
};
