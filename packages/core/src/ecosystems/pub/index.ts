import { parse as parseYaml } from 'yaml';
import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, Subproject, Warning } from '../../model/types.js';
import { basename, joinPath } from '../../sources/file-provider.js';
import { SUPPORTED_FILES } from '../files.js';
import { pubVersioning } from './versioning.js';
import type { EcosystemPlugin } from '../types.js';

interface PubPackage {
  dependency?: string;
  source?: string;
  version?: string;
  description?: unknown;
}

const DEFAULT_HOSTS = /^https:\/\/pub\.(dev|dartlang\.org)\/?$/;

/**
 * pubspec.lock: `packages:` map with `dependency: "direct main" | "direct dev" |
 * "direct overridden" | "transitive"`. There are no dependency edges, so every package
 * hangs off the root (as with go.mod); only `hosted` packages on pub.dev are scanned.
 */
export function parsePubspecLock(
  content: string,
  sourceFile: string,
  rootName: string,
): { graph: DependencyGraph; warnings: Warning[] } {
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (e) {
    warnings.push({
      code: 'malformed-lockfile',
      message: `${sourceFile}: invalid YAML (${(e as Error).message.split('\n')[0]})`,
      file: sourceFile,
    });
    return { graph, warnings };
  }
  const packages = (doc as { packages?: unknown } | null)?.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    warnings.push({
      code: 'malformed-lockfile',
      message: `${sourceFile}: no "packages" map`,
      file: sourceFile,
    });
    return { graph, warnings };
  }

  for (const [name, raw] of Object.entries(packages as Record<string, unknown>)) {
    const pkg = (raw && typeof raw === 'object' ? raw : {}) as PubPackage;
    const description =
      pkg.description && typeof pkg.description === 'object'
        ? (pkg.description as { url?: unknown })
        : undefined;
    const hosted =
      pkg.source === 'hosted' &&
      (typeof description?.url !== 'string' || DEFAULT_HOSTS.test(description.url));
    if (!hosted || typeof pkg.version !== 'string' || !pubVersioning.isValid(pkg.version)) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${name}: ${pkg.source ?? 'unknown'} source is not pub.dev`,
        file: sourceFile,
      });
      continue;
    }
    const kind = pkg.dependency ?? 'transitive';
    const id = addNode(graph, {
      ecosystem: 'Pub',
      name,
      version: pkg.version,
      isDirect: kind.startsWith('direct'),
      sourceFile,
      confidence: 'high',
      scope: kind === 'direct dev' ? 'dev' : 'prod',
    });
    addEdge(graph, ROOT_ID, id);
  }
  return { graph, warnings };
}

export const pubPlugin: EcosystemPlugin = {
  id: 'Pub',
  displayName: 'Dart / Flutter (pub)',
  files: SUPPORTED_FILES.Pub,
  versioning: pubVersioning,

  async parse({ dir, files, provider }) {
    if (!files.some((f) => basename(f) === 'pubspec.lock'))
      return { subprojects: [], warnings: [] };
    const lockPath = joinPath(dir, 'pubspec.lock');
    const { graph, warnings } = parsePubspecLock(
      await provider.read(lockPath),
      lockPath,
      dir ? basename(dir) : 'root',
    );
    const sub: Subproject = { path: dir, ecosystem: 'Pub', graph, warnings };
    return { subprojects: [sub], warnings: [] };
  },
};
