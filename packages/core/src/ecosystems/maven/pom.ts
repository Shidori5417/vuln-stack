import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, DependencyScope, Warning } from '../../model/types.js';
import { dirname, joinPath, type FileProvider } from '../../sources/file-provider.js';
import { mavenVersioning } from './versioning.js';

interface PomDependency {
  groupId?: string;
  artifactId?: string;
  version?: string | number;
  scope?: string;
  type?: string;
  optional?: boolean | string;
}

export interface Pom {
  groupId?: string;
  artifactId?: string;
  version?: string | number;
  packaging?: string;
  parent?: {
    groupId?: string;
    artifactId?: string;
    version?: string | number;
    relativePath?: string;
  };
  properties?: Record<string, string | number | boolean>;
  dependencyManagement?: { dependencies?: { dependency?: PomDependency | PomDependency[] } };
  dependencies?: { dependency?: PomDependency | PomDependency[] };
}

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

const asArray = <T>(x: T | T[] | undefined): T[] =>
  x === undefined ? [] : Array.isArray(x) ? x : [x];

export function readPom(content: string, file: string): Pom {
  // The parser is lenient with malformed XML, so validate first.
  const valid = XMLValidator.validate(content);
  if (valid !== true)
    throw new Error(`${file}: invalid XML (${valid.err.msg}, line ${valid.err.line})`);
  const doc = xml.parse(content) as { project?: Pom };
  if (!doc.project) throw new Error(`${file}: no <project> element`);
  return doc.project;
}

interface Context {
  properties: Map<string, string>;
  managed: Map<string, string>;
}

/** Child values win over parent values, like Maven's inheritance. */
function contextFor(chain: Pom[]): Context {
  const properties = new Map<string, string>();
  const managed = new Map<string, string>();
  for (const pom of [...chain].reverse()) {
    for (const [k, v] of Object.entries(pom.properties ?? {})) properties.set(k, String(v));
    const version = pom.version ?? pom.parent?.version;
    if (version !== undefined) {
      properties.set('project.version', String(version));
      properties.set('pom.version', String(version));
    }
    if (pom.parent?.version !== undefined)
      properties.set('project.parent.version', String(pom.parent.version));
    const groupId = pom.groupId ?? pom.parent?.groupId;
    if (groupId) properties.set('project.groupId', groupId);
  }
  for (const pom of [...chain].reverse()) {
    for (const d of asArray(pom.dependencyManagement?.dependencies?.dependency)) {
      if (d.groupId && d.artifactId && d.version !== undefined && d.type !== 'pom') {
        managed.set(
          `${interpolate(d.groupId, properties)}:${interpolate(d.artifactId, properties)}`,
          String(d.version),
        );
      }
    }
  }
  return { properties, managed };
}

/** Expands `${name}` references (recursively, cycle-safe). */
export function interpolate(value: string, properties: Map<string, string>, depth = 0): string {
  if (depth > 10) return value;
  const out = value.replace(/\$\{([^}]+)\}/g, (match, key: string) => properties.get(key) ?? match);
  return out !== value && out.includes('${') ? interpolate(out, properties, depth + 1) : out;
}

/** Loads the pom plus its parents (via relativePath, default ../pom.xml) when they are in the tree. */
export async function loadPomChain(
  path: string,
  provider: FileProvider,
  maxDepth = 5,
): Promise<Pom[]> {
  const chain: Pom[] = [];
  let current: string | undefined = path;
  const seen = new Set<string>();
  while (current && chain.length <= maxDepth && !seen.has(current)) {
    seen.add(current);
    let pom: Pom;
    try {
      pom = readPom(await provider.read(current), current);
    } catch (e) {
      if (chain.length === 0) throw e;
      break; // parent outside the scanned tree
    }
    chain.push(pom);
    if (!pom.parent) break;
    const rel = pom.parent.relativePath ?? '../pom.xml';
    const target = rel.endsWith('.xml') ? rel : `${rel.replace(/\/$/, '')}/pom.xml`;
    current = normalizePath(joinPath(dirname(current), target));
  }
  return chain;
}

function normalizePath(path: string): string | undefined {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '..') {
      if (out.length === 0) return undefined; // escapes the scanned root
      out.pop();
    } else if (seg && seg !== '.') {
      out.push(seg);
    }
  }
  return out.join('/');
}

const SCOPES: Record<string, DependencyScope> = {
  test: 'dev',
  provided: 'prod',
  runtime: 'prod',
  compile: 'prod',
  system: 'prod',
  import: 'prod',
};

export function pomGraph(
  chain: Pom[],
  sourceFile: string,
  fallbackName: string,
): { graph: DependencyGraph; warnings: Warning[] } {
  const pom = chain[0]!;
  const ctx = contextFor(chain);
  const graph = createGraph(
    pom.artifactId ? interpolate(pom.artifactId, ctx.properties) : fallbackName,
  );
  const warnings: Warning[] = [];

  for (const d of asArray(pom.dependencies?.dependency)) {
    if (!d.groupId || !d.artifactId) continue;
    const name = `${interpolate(d.groupId, ctx.properties)}:${interpolate(d.artifactId, ctx.properties)}`;
    const rawVersion = d.version !== undefined ? String(d.version) : ctx.managed.get(name);
    if (rawVersion === undefined) {
      warnings.push({
        code: 'unresolved-version',
        message: `${name}: version is managed outside this project (parent POM or BOM); not scanned`,
        file: sourceFile,
      });
      continue;
    }
    const version = interpolate(rawVersion, ctx.properties);
    if (version.includes('${')) {
      warnings.push({
        code: 'unresolved-version',
        message: `${name}: cannot resolve ${version}; not scanned`,
        file: sourceFile,
      });
      continue;
    }
    const isRange = /^[[(]/.test(version);
    if (!isRange && !mavenVersioning.isValid(version)) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${name}: unsupported version "${version}"`,
        file: sourceFile,
      });
      continue;
    }
    const id = addNode(graph, {
      ecosystem: 'Maven',
      name,
      version: isRange ? '' : version,
      ...(isRange ? { declaredRange: version } : {}),
      isDirect: true,
      sourceFile,
      confidence: isRange ? 'medium' : 'high',
      scope: SCOPES[d.scope ?? 'compile'] ?? 'prod',
    });
    addEdge(graph, ROOT_ID, id);
  }
  warnings.push({
    code: 'direct-only',
    message:
      'pom.xml lists direct dependencies only; transitive dependencies are not scanned. Use a lock file (e.g. gradle.lockfile) for full coverage.',
    file: sourceFile,
  });
  return { graph, warnings };
}
