import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, Subproject, Warning } from '../../model/types.js';
import { basename, joinPath } from '../../sources/file-provider.js';
import type { EcosystemPlugin } from '../types.js';
import { goVersioning } from './versioning.js';
import { SUPPORTED_FILES } from '../files.js';

interface Require {
  path: string;
  version: string;
  indirect: boolean;
}

interface Replace {
  from: string;
  fromVersion?: string;
  to: string;
  toVersion?: string;
}

export interface GoMod {
  module?: string;
  go?: string;
  toolchain?: string;
  requires: Require[];
  replaces: Replace[];
}

const stripComment = (line: string) => line.replace(/\/\/.*$/, '').trim();
const unquote = (s: string) => s.replace(/^"(.*)"$/, '$1').replace(/^`(.*)`$/, '$1');

export function parseGoMod(content: string): GoMod {
  const mod: GoMod = { requires: [], replaces: [] };
  let block: string | undefined;

  const handle = (directive: string, rest: string, raw: string) => {
    if (directive === 'require') {
      const [path, version] = stripComment(rest).split(/\s+/);
      if (path && version)
        mod.requires.push({ path: unquote(path), version, indirect: /\/\/\s*indirect/.test(raw) });
    } else if (directive === 'replace') {
      const m = /^(\S+)(?:\s+(\S+))?\s*=>\s*(\S+)(?:\s+(\S+))?$/.exec(stripComment(rest));
      if (m) {
        const r: Replace = { from: unquote(m[1]!), to: unquote(m[3]!) };
        if (m[2]) r.fromVersion = m[2];
        if (m[4]) r.toVersion = m[4];
        mod.replaces.push(r);
      }
    }
  };

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (block) {
      if (line === ')') block = undefined;
      else handle(block, line, raw);
      continue;
    }
    const m = /^(\w+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, directive, rest] = m as unknown as [string, string, string];
    if (rest === '(') {
      block = directive;
    } else if (directive === 'module') {
      mod.module = unquote(stripComment(rest));
    } else if (directive === 'go') {
      mod.go = stripComment(rest);
    } else if (directive === 'toolchain') {
      mod.toolchain = stripComment(rest);
    } else {
      handle(directive, rest, raw);
    }
  }
  return mod;
}

const versionAtLeast = (v: string | undefined, major: number, minor: number) => {
  const m = /^(\d+)\.(\d+)/.exec(v ?? '');
  return m ? Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor) : false;
};

export function goModGraph(
  mod: GoMod,
  sourceFile: string,
  fallbackName: string,
): { graph: DependencyGraph; warnings: Warning[] } {
  const graph = createGraph(mod.module ?? fallbackName);
  const warnings: Warning[] = [];

  for (const req of mod.requires) {
    const rep = mod.replaces.find(
      (r) => r.from === req.path && (!r.fromVersion || r.fromVersion === req.version),
    );
    let path = req.path;
    let version = req.version;
    if (rep) {
      if (!rep.toVersion) {
        warnings.push({
          code: 'non-registry-version',
          message: `Skipping ${req.path}: replaced by local path ${rep.to}`,
          file: sourceFile,
        });
        continue;
      }
      path = rep.to;
      version = rep.toVersion;
    }
    if (!goVersioning.isValid(version)) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${path}: invalid version ${version}`,
        file: sourceFile,
      });
      continue;
    }
    const id = addNode(graph, {
      ecosystem: 'Go',
      name: path,
      version,
      isDirect: !req.indirect,
      sourceFile,
      confidence: 'high',
      scope: 'prod',
    });
    // go.mod has no edges; indirect modules hang off the root too.
    addEdge(graph, ROOT_ID, id);
  }

  // The standard library is a dependency too (OSV package "stdlib").
  const toolchain = /^go(\d+\.\d+(?:\.\d+)?)/.exec(mod.toolchain ?? '')?.[1];
  const goDirective = /^\d+\.\d+\.\d+$/.test(mod.go ?? '') ? mod.go : undefined;
  const stdlib = toolchain ?? goDirective;
  if (stdlib) {
    const id = addNode(graph, {
      ecosystem: 'Go',
      name: 'stdlib',
      version: stdlib,
      isDirect: true,
      sourceFile,
      confidence: toolchain ? 'medium' : 'low',
      scope: 'prod',
    });
    addEdge(graph, ROOT_ID, id);
  }

  if (mod.go && !versionAtLeast(mod.go, 1, 17)) {
    warnings.push({
      code: 'incomplete-go-mod',
      message: `go ${mod.go} modules don't list every indirect dependency; run "go mod tidy -go=1.17" for full coverage`,
      file: sourceFile,
    });
  }
  return { graph, warnings };
}

export const goPlugin: EcosystemPlugin = {
  id: 'Go',
  displayName: 'Go modules',
  files: SUPPORTED_FILES.Go,
  versioning: goVersioning,

  async parse({ dir, provider }) {
    const path = joinPath(dir, 'go.mod');
    const { graph, warnings } = goModGraph(
      parseGoMod(await provider.read(path)),
      path,
      dir ? basename(dir) : 'root',
    );
    const sub: Subproject = { path: dir, ecosystem: 'Go', graph, warnings };
    return { subprojects: [sub], warnings: [] };
  },
};
