import { DEFAULT_TTL_SECONDS } from '../../cache/types.js';
import { fetchJson } from '../../net/http.js';
import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, DependencyScope, Subproject, Warning } from '../../model/types.js';
import { basename, joinPath } from '../../sources/file-provider.js';
import type { EcosystemPlugin } from '../types.js';
import { parseComposerConstraint } from './constraints.js';
import { packagistVersioning, parseComposerVersion } from './versioning.js';
import { SUPPORTED_FILES } from '../files.js';

interface ComposerJson {
  name?: string;
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
}

interface LockPackage {
  name: string;
  version: string;
  require?: Record<string, string>;
}

interface ComposerLock {
  packages?: LockPackage[];
  'packages-dev'?: LockPackage[];
}

/** php, ext-*, lib-*, composer-plugin-api… are platform requirements, not packages. */
export const isPlatformPackage = (name: string) => !name.includes('/');

const normalize = (name: string) => name.toLowerCase();

function readJson<T>(content: string, file: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (e) {
    throw new Error(`${file}: invalid JSON (${(e as Error).message})`, { cause: e });
  }
}

export function parseComposerLock(
  content: string,
  sourceFile: string,
  rootName: string,
  manifest?: ComposerJson,
): { graph: DependencyGraph; warnings: Warning[] } {
  const lock = readJson<ComposerLock>(content, sourceFile);
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  const ids = new Map<string, string>();
  const all: [LockPackage, DependencyScope][] = [
    ...(lock.packages ?? []).map((p) => [p, 'prod'] as [LockPackage, DependencyScope]),
    ...(lock['packages-dev'] ?? []).map((p) => [p, 'dev'] as [LockPackage, DependencyScope]),
  ];

  for (const [pkg, scope] of all) {
    if (!parseComposerVersion(pkg.version)) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${pkg.name}: "${pkg.version}" is a branch, not a release`,
        file: sourceFile,
      });
      continue;
    }
    ids.set(
      normalize(pkg.name),
      addNode(graph, {
        ecosystem: 'Packagist',
        name: normalize(pkg.name),
        version: pkg.version.replace(/^v/, ''),
        isDirect: false,
        sourceFile,
        confidence: 'high',
        scope,
      }),
    );
  }
  for (const [pkg] of all) {
    const from = ids.get(normalize(pkg.name));
    if (!from) continue;
    for (const dep of Object.keys(pkg.require ?? {})) {
      const to = ids.get(normalize(dep));
      if (to) addEdge(graph, from, to);
    }
  }

  const direct = manifest
    ? [...Object.keys(manifest.require ?? {}), ...Object.keys(manifest['require-dev'] ?? {})]
    : undefined;
  if (direct) {
    for (const name of direct) {
      const id = ids.get(normalize(name));
      if (!id) continue;
      graph.nodes.get(id)!.isDirect = true;
      addEdge(graph, ROOT_ID, id);
    }
  } else {
    const reached = new Set<string>();
    for (const children of graph.edges.values()) for (const c of children) reached.add(c);
    for (const id of ids.values()) {
      if (reached.has(id)) continue;
      graph.nodes.get(id)!.isDirect = true;
      addEdge(graph, ROOT_ID, id);
    }
  }
  return { graph, warnings };
}

export function composerManifestGraph(
  manifest: ComposerJson,
  sourceFile: string,
  rootName: string,
) {
  const graph = createGraph(manifest.name ?? rootName);
  const warnings: Warning[] = [];
  for (const [deps, scope] of [
    [manifest.require, 'prod'],
    [manifest['require-dev'], 'dev'],
  ] as const) {
    for (const [name, constraint] of Object.entries(deps ?? {})) {
      if (isPlatformPackage(name)) continue;
      if (/^dev-/.test(constraint.trim())) {
        warnings.push({
          code: 'non-registry-version',
          message: `Skipping ${name}: "${constraint}" is a branch`,
          file: sourceFile,
        });
        continue;
      }
      const id = addNode(graph, {
        ecosystem: 'Packagist',
        name: normalize(name),
        version: '',
        declaredRange: constraint,
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
      'No composer.lock found; versions are resolved from composer.json constraints and may differ from what is installed. Transitive dependencies are not scanned.',
    file: sourceFile,
  });
  return { graph, warnings };
}

export const packagistPlugin: EcosystemPlugin = {
  id: 'Packagist',
  displayName: 'Composer (Packagist)',
  files: SUPPORTED_FILES.Packagist,
  versioning: packagistVersioning,
  normalizeName: normalize,

  async parse({ dir, files, provider }) {
    const names = new Set(files.map(basename));
    const manifestPath = joinPath(dir, 'composer.json');
    const manifest = names.has('composer.json')
      ? readJson<ComposerJson>(await provider.read(manifestPath), manifestPath)
      : undefined;
    const rootName = manifest?.name ?? (dir ? basename(dir) : 'root');
    let result;
    if (names.has('composer.lock')) {
      const lockPath = joinPath(dir, 'composer.lock');
      result = parseComposerLock(await provider.read(lockPath), lockPath, rootName, manifest);
    } else if (manifest) {
      result = composerManifestGraph(manifest, manifestPath, rootName);
    } else {
      return { subprojects: [], warnings: [] };
    }
    const sub: Subproject = {
      path: dir,
      ecosystem: 'Packagist',
      graph: result.graph,
      warnings: result.warnings,
    };
    return { subprojects: [sub], warnings: [] };
  },

  async resolveRange(name, range, net) {
    const matches = parseComposerConstraint(range);
    if (!matches) return null;
    const key = `packagist:${name}`;
    let versions = await net.cache.get<string[]>(key);
    if (!versions) {
      const data = await fetchJson<{ packages?: Record<string, { version?: string }[]> }>(
        net.fetch,
        `https://repo.packagist.org/p2/${name}.json`,
        { headers: { 'user-agent': net.userAgent } },
        net.signal ? { signal: net.signal } : {},
      );
      versions = (data.packages?.[name] ?? [])
        .map((p) => p.version ?? '')
        .filter((v) => parseComposerVersion(v));
      await net.cache.set(key, versions, DEFAULT_TTL_SECONDS);
    }
    // Composer's default minimum-stability is "stable".
    const wantsUnstable = /@(dev|alpha|beta|rc)|-(alpha|beta|rc)/i.test(range);
    const candidates = versions.filter(
      (v) => matches(v) && (wantsUnstable || parseComposerVersion(v)!.stability >= 4),
    );
    return candidates.sort(packagistVersioning.compare).at(-1)?.replace(/^v/, '') ?? null;
  },
};
