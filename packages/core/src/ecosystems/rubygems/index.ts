import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, Subproject, Warning } from '../../model/types.js';
import { basename, joinPath } from '../../sources/file-provider.js';
import { SUPPORTED_FILES } from '../files.js';
import { rootIds } from '../shared.js';
import type { EcosystemPlugin } from '../types.js';
import { rubygemsVersioning } from './versioning.js';

const SOURCE_SECTIONS = new Set(['GEM', 'GIT', 'PATH', 'PLUGIN SOURCE']);

interface Spec {
  name: string;
  version: string;
  section: string;
  deps: Set<string>;
}

/** `1.13.3-x86_64-linux` → `1.13.3`: the platform suffix is not part of the version. */
export const stripPlatform = (version: string) => version.split('-')[0]!;

/**
 * Gemfile.lock: GEM/GIT/PATH `specs:` hold `name (version)` with their dependencies
 * indented below; DEPENDENCIES lists the Gemfile's own gems. Git and path gems are
 * first-party (internal) so chains stay intact; the lock has no group information.
 */
export function parseGemfileLock(
  content: string,
  sourceFile: string,
  rootName: string,
): { graph: DependencyGraph; warnings: Warning[] } {
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  const specs = new Map<string, Spec>(); // key: name@version (platform variants merged)
  const byName = new Map<string, string>();
  const declared: string[] = [];
  let section = '';
  let inSpecs = false;
  let current: Spec | undefined;

  for (const raw of content.split(/\r?\n/)) {
    if (/^[A-Z][A-Z ]*$/.test(raw)) {
      section = raw.trim();
      inSpecs = false;
      current = undefined;
      continue;
    }
    if (SOURCE_SECTIONS.has(section)) {
      if (/^ {2}specs:\s*$/.test(raw)) {
        inSpecs = true;
        continue;
      }
      if (!inSpecs) continue;
      const spec = /^ {4}(\S+) \(([^)]+)\)\s*$/.exec(raw);
      if (spec) {
        const version = stripPlatform(spec[2]!);
        const key = `${spec[1]}@${version}`;
        current = specs.get(key) ?? {
          name: spec[1]!,
          version,
          section,
          deps: new Set<string>(),
        };
        specs.set(key, current);
        byName.set(current.name, key);
        continue;
      }
      const dep = /^ {6}(\S+)(?: \([^)]*\))?\s*$/.exec(raw);
      if (dep && current) current.deps.add(dep[1]!);
    } else if (section === 'DEPENDENCIES') {
      const dep = /^ {2}([^\s!(]+)(?: \([^)]*\))?!?\s*$/.exec(raw);
      if (dep) declared.push(dep[1]!);
    }
  }

  const ids = new Map<string, string>(); // spec key → node id
  for (const [key, spec] of specs) {
    const internal = spec.section !== 'GEM';
    if (!internal && !rubygemsVersioning.isValid(spec.version)) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${spec.name}: invalid version ${spec.version}`,
        file: sourceFile,
      });
      continue;
    }
    if (spec.section === 'GIT') {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${spec.name}: installed from git, not RubyGems`,
        file: sourceFile,
      });
    } else if (internal) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${spec.name}: ${spec.section === 'PATH' ? 'local path gem' : 'non-registry source'}`,
        file: sourceFile,
      });
    }
    ids.set(
      key,
      addNode(graph, {
        ecosystem: 'RubyGems',
        name: spec.name,
        version: spec.version,
        isDirect: false,
        sourceFile,
        confidence: 'high',
        scope: 'prod',
        ...(internal ? { internal: true } : {}),
      }),
    );
  }

  for (const [key, spec] of specs) {
    const from = ids.get(key);
    if (!from) continue;
    for (const dep of spec.deps) {
      const to = ids.get(byName.get(dep) ?? '');
      if (to) addEdge(graph, from, to);
    }
  }

  const direct = declared.map((n) => ids.get(byName.get(n) ?? '')).filter((id) => id !== undefined);
  for (const id of direct.length || declared.length ? direct : rootIds(graph, ids.values())) {
    graph.nodes.get(id!)!.isDirect = true;
    addEdge(graph, ROOT_ID, id!);
  }
  return { graph, warnings };
}

export const rubygemsPlugin: EcosystemPlugin = {
  id: 'RubyGems',
  displayName: 'Bundler (RubyGems)',
  files: SUPPORTED_FILES.RubyGems,
  versioning: rubygemsVersioning,

  async parse({ dir, files, provider }) {
    if (!files.some((f) => basename(f) === 'Gemfile.lock'))
      return { subprojects: [], warnings: [] };
    const lockPath = joinPath(dir, 'Gemfile.lock');
    const { graph, warnings } = parseGemfileLock(
      await provider.read(lockPath),
      lockPath,
      dir ? basename(dir) : 'root',
    );
    const sub: Subproject = { path: dir, ecosystem: 'RubyGems', graph, warnings };
    return { subprojects: [sub], warnings: [] };
  },
};
