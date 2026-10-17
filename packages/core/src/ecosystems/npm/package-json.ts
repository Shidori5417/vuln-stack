import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, DependencyScope, Warning } from '../../model/types.js';

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export function readPackageJson(content: string, sourceFile: string): PackageJson {
  try {
    return JSON.parse(content) as PackageJson;
  } catch (error) {
    throw new Error(`${sourceFile}: invalid JSON (${(error as Error).message})`, { cause: error });
  }
}

export function directDependencyNames(pkg: PackageJson): Set<string> {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

const NON_REGISTRY_RANGE =
  /^(file:|link:|workspace:|git\+|git:|github:|https?:|[^@/\s]+\/[^@/\s]+$)/;

/**
 * Manifest-only parse. Versions stay empty with the range in `declaredRange`;
 * the scanner resolves them later and marks confidence accordingly.
 */
export function parsePackageJsonManifest(
  pkg: PackageJson,
  sourceFile: string,
  fallbackRootName: string,
): { graph: DependencyGraph; warnings: Warning[] } {
  const graph = createGraph(pkg.name || fallbackRootName);
  const warnings: Warning[] = [];
  const groups: [Record<string, string> | undefined, DependencyScope][] = [
    [pkg.dependencies, 'prod'],
    [pkg.optionalDependencies, 'optional'],
    [pkg.peerDependencies, 'peer'],
    [pkg.devDependencies, 'dev'],
  ];

  for (const [deps, scope] of groups) {
    for (const [declaredName, rawRange] of Object.entries(deps ?? {})) {
      let name = declaredName;
      let range = rawRange.trim();
      // npm aliases: "foo": "npm:bar@^1.0.0"
      const alias = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.*))?$/.exec(range);
      if (alias) {
        name = alias[1]!;
        range = alias[2] ?? '*';
      }
      if (NON_REGISTRY_RANGE.test(range)) {
        warnings.push({
          code: 'non-registry-version',
          message: `Skipping ${declaredName}: "${rawRange}" is not a registry range`,
          file: sourceFile,
        });
        continue;
      }
      const id = addNode(graph, {
        ecosystem: 'npm',
        name,
        version: '',
        declaredRange: range || '*',
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
      'No lock file found; versions are resolved from package.json ranges and may differ from what is installed. Transitive dependencies are not scanned.',
    file: sourceFile,
  });
  return { graph, warnings };
}
