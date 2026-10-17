import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { DEFAULT_TTL_SECONDS } from '../../cache/types.js';
import { fetchJson } from '../../net/http.js';
import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, DependencyScope, Subproject, Warning } from '../../model/types.js';
import { basename, dirname, joinPath, type FileProvider } from '../../sources/file-provider.js';
import type { EcosystemPlugin } from '../types.js';
import { nugetVersioning, parseNuGetVersion } from './versioning.js';
import { SUPPORTED_FILES } from '../files.js';

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  isArray: (name) => ['PackageReference', 'PackageVersion', 'package', 'ItemGroup'].includes(name),
});

function readXml<T>(content: string, file: string): T {
  const valid = XMLValidator.validate(content);
  if (valid !== true)
    throw new Error(`${file}: invalid XML (${valid.err.msg}, line ${valid.err.line})`);
  return xml.parse(content) as T;
}

interface LockEntry {
  type?: string;
  resolved?: string;
  dependencies?: Record<string, string>;
}

/** packages.lock.json: one section per target framework; merged into one graph. */
export function parseNuGetLock(
  content: string,
  sourceFile: string,
  rootName: string,
): { graph: DependencyGraph; warnings: Warning[] } {
  let doc: { dependencies?: Record<string, Record<string, LockEntry>> };
  try {
    doc = JSON.parse(content) as typeof doc;
  } catch (e) {
    throw new Error(`${sourceFile}: invalid JSON (${(e as Error).message})`, { cause: e });
  }
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  const ids = new Map<string, string>(); // lower-cased id → node id
  const frameworks = Object.values(doc.dependencies ?? {});

  for (const packages of frameworks) {
    for (const [name, entry] of Object.entries(packages)) {
      if (entry.type === 'Project' || !entry.resolved) continue;
      if (!parseNuGetVersion(entry.resolved)) {
        warnings.push({
          code: 'non-registry-version',
          message: `Skipping ${name}: invalid version ${entry.resolved}`,
          file: sourceFile,
        });
        continue;
      }
      const id = addNode(graph, {
        ecosystem: 'NuGet',
        name,
        version: entry.resolved,
        isDirect: entry.type === 'Direct',
        sourceFile,
        confidence: 'high',
        scope: 'prod',
      });
      ids.set(name.toLowerCase(), id);
      if (entry.type === 'Direct') addEdge(graph, ROOT_ID, id);
    }
  }
  for (const packages of frameworks) {
    for (const [name, entry] of Object.entries(packages)) {
      const from = ids.get(name.toLowerCase());
      if (!from) continue;
      for (const dep of Object.keys(entry.dependencies ?? {})) {
        const to = ids.get(dep.toLowerCase());
        if (to) addEdge(graph, from, to);
      }
    }
  }
  return { graph, warnings };
}

interface PackageRef {
  '@Include'?: string;
  '@Update'?: string;
  '@Version'?: string;
  '@VersionOverride'?: string;
  '@PrivateAssets'?: string;
  Version?: string;
  PrivateAssets?: string;
}

interface Project {
  Project?: { ItemGroup?: { PackageReference?: PackageRef[]; PackageVersion?: PackageRef[] }[] };
}

/** Central package management: the nearest Directory.Packages.props up the tree. */
async function centralVersions(dir: string, provider: FileProvider): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  for (let d = dir; ; d = dirname(d)) {
    const path = joinPath(d, 'Directory.Packages.props');
    const content = await provider.read(path).catch(() => undefined);
    if (content !== undefined) {
      const doc = readXml<Project>(content, path);
      for (const group of doc.Project?.ItemGroup ?? []) {
        for (const pv of group.PackageVersion ?? []) {
          const id = pv['@Include'] ?? pv['@Update'];
          const version = pv['@Version'] ?? pv.Version;
          if (id && version) versions.set(id.toLowerCase(), version);
        }
      }
      return versions;
    }
    if (!d) return versions;
  }
}

/** Bare NuGet versions mean "this or higher", but restore picks the lowest match: treat as exact. */
const nugetExact = (spec: string): string | undefined =>
  parseNuGetVersion(spec) ? spec : /^\[([^,\]]+)\]$/.exec(spec)?.[1]?.trim();

export async function parseProjectFile(
  content: string,
  path: string,
  provider: FileProvider,
): Promise<{ graph: DependencyGraph; warnings: Warning[] }> {
  const doc = readXml<Project>(content, path);
  const central = await centralVersions(dirname(path), provider);
  const graph = createGraph(basename(path).replace(/\.\w+proj$/, ''));
  const warnings: Warning[] = [];
  for (const group of doc.Project?.ItemGroup ?? []) {
    for (const ref of group.PackageReference ?? []) {
      const name = ref['@Include'];
      if (!name) continue;
      const spec =
        ref['@VersionOverride'] ??
        ref['@Version'] ??
        ref.Version ??
        central.get(name.toLowerCase());
      if (!spec) {
        warnings.push({
          code: 'unresolved-version',
          message: `${name}: no version found (Directory.Build.props?); not scanned`,
          file: path,
        });
        continue;
      }
      const exact = nugetExact(spec.trim());
      const privateAssets = (ref['@PrivateAssets'] ?? ref.PrivateAssets ?? '').toLowerCase();
      const scope: DependencyScope = privateAssets === 'all' ? 'dev' : 'prod';
      const id = addNode(graph, {
        ecosystem: 'NuGet',
        name,
        version: exact ?? '',
        ...(exact ? {} : { declaredRange: spec.trim() }),
        isDirect: true,
        sourceFile: path,
        confidence: exact ? 'high' : 'medium',
        scope,
      });
      addEdge(graph, ROOT_ID, id);
    }
  }
  warnings.push({
    code: 'direct-only',
    message:
      'Project files list direct packages only; enable RestorePackagesWithLockFile (packages.lock.json) to scan transitive packages.',
    file: path,
  });
  return { graph, warnings };
}

/** Legacy packages.config: a flat, exact list. */
export function parsePackagesConfig(content: string, path: string, rootName: string) {
  const doc = readXml<{
    packages?: {
      package?: { '@id'?: string; '@version'?: string; '@developmentDependency'?: string }[];
    };
  }>(content, path);
  const graph = createGraph(rootName);
  for (const p of doc.packages?.package ?? []) {
    if (!p['@id'] || !p['@version']) continue;
    const id = addNode(graph, {
      ecosystem: 'NuGet',
      name: p['@id'],
      version: p['@version'],
      isDirect: true,
      sourceFile: path,
      confidence: 'high',
      scope: p['@developmentDependency'] === 'true' ? 'dev' : 'prod',
    });
    addEdge(graph, ROOT_ID, id);
  }
  return { graph, warnings: [] as Warning[] };
}

/** NuGet range `[1.0,2.0)`, `(1.0,)`, bare `1.0` (= ≥1.0) or floating `1.*`. */
export function parseNuGetRange(
  spec: string,
): { matches: (v: string) => boolean; floating: boolean } | undefined {
  const s = spec.trim();
  if (s.includes('*')) {
    const prefix = s.slice(0, s.indexOf('*'));
    return { matches: (v) => v.startsWith(prefix), floating: true };
  }
  if (parseNuGetVersion(s))
    return { matches: (v) => nugetVersioning.compare(v, s) >= 0, floating: false };
  const m = /^([[(])\s*([^,]*?)\s*(?:,\s*([^\])]*?)\s*)?([\])])$/.exec(s);
  if (!m) return undefined;
  const [, open, lo, hi, close] = m as unknown as [
    string,
    string,
    string,
    string | undefined,
    string,
  ];
  if (hi === undefined)
    return { matches: (v) => nugetVersioning.compare(v, lo) === 0, floating: false };
  return {
    floating: false,
    matches: (v) =>
      (!lo ||
        (open === '['
          ? nugetVersioning.compare(v, lo) >= 0
          : nugetVersioning.compare(v, lo) > 0)) &&
      (!hi ||
        (close === ']' ? nugetVersioning.compare(v, hi) <= 0 : nugetVersioning.compare(v, hi) < 0)),
  };
}

export const nugetPlugin: EcosystemPlugin = {
  id: 'NuGet',
  displayName: 'NuGet',
  files: SUPPORTED_FILES.NuGet,
  versioning: nugetVersioning,
  normalizeName: (name) => name.toLowerCase(),

  async parse({ dir, files, provider }) {
    const names = new Set(files.map(basename));
    const project = files.find((f) => /\.(cs|fs|vb)proj$/.test(f));
    const rootName = project
      ? basename(project).replace(/\.\w+proj$/, '')
      : dir
        ? basename(dir)
        : 'root';
    let result;
    if (names.has('packages.lock.json')) {
      const path = joinPath(dir, 'packages.lock.json');
      result = parseNuGetLock(await provider.read(path), path, rootName);
    } else if (names.has('packages.config')) {
      const path = joinPath(dir, 'packages.config');
      result = parsePackagesConfig(await provider.read(path), path, rootName);
    } else if (project) {
      result = await parseProjectFile(await provider.read(project), project, provider);
    } else {
      return { subprojects: [], warnings: [] };
    }
    const sub: Subproject = {
      path: dir,
      ecosystem: 'NuGet',
      graph: result.graph,
      warnings: result.warnings,
    };
    return { subprojects: [sub], warnings: [] };
  },

  async resolveRange(name, range, net) {
    const parsed = parseNuGetRange(range);
    if (!parsed) return null;
    const key = `nuget-versions:${name.toLowerCase()}`;
    let versions = await net.cache.get<string[]>(key);
    if (!versions) {
      const data = await fetchJson<{ versions?: string[] }>(
        net.fetch,
        `https://api.nuget.org/v3-flatcontainer/${name.toLowerCase()}/index.json`,
        { headers: { 'user-agent': net.userAgent } },
        net.signal ? { signal: net.signal } : {},
      );
      versions = data.versions ?? [];
      await net.cache.set(key, versions, DEFAULT_TTL_SECONDS);
    }
    const stable = versions
      .filter((v) => !v.includes('-') && parsed.matches(v))
      .sort(nugetVersioning.compare);
    // Floating versions take the highest match; ranges take the lowest (NuGet's rule).
    return (parsed.floating ? stable.at(-1) : stable[0]) ?? null;
  },
};
