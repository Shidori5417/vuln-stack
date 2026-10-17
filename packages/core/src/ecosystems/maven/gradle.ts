import { parse as parseToml } from 'smol-toml';
import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, DependencyScope, Warning } from '../../model/types.js';
import { mavenVersioning } from './versioning.js';

export interface DeclaredDep {
  name: string;
  /** Version or range as written ('' when the version comes from a platform/BOM). */
  version: string;
  scope: DependencyScope;
}

const CONFIGS =
  'implementation|api|compile|compileOnly|runtimeOnly|runtime|testImplementation|testCompile|testRuntimeOnly|testCompileOnly|androidTestImplementation|kapt|ksp|annotationProcessor|classpath';

const isTestConfig = (c: string) => /^(test|androidTest)/.test(c);

/** Collects `val x = "1.0"`, `def x = '1.0'`, `ext.x = '1.0'` and `ext { x = '1.0' }` style variables. */
function variables(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  const re = /(?:\b(?:val|var|def)\s+|\bext\.|^\s*)([A-Za-z_][\w]*)\s*=\s*["']([^"'$]+)["']/gm;
  for (const m of content.matchAll(re)) vars.set(m[1]!, m[2]!);
  return vars;
}

function expand(text: string, vars: Map<string, string>): string {
  return text.replace(
    /\$\{?([A-Za-z_][\w.]*)\}?/g,
    (match, key: string) =>
      vars.get(key.replace(/^(project\.|rootProject\.)?(ext\.)?/, '')) ?? match,
  );
}

/** Dependencies declared in build.gradle / build.gradle.kts (string and map notations). */
export function parseGradleBuild(
  content: string,
  file: string,
): { deps: DeclaredDep[]; warnings: Warning[] } {
  const vars = variables(content);
  const deps: DeclaredDep[] = [];
  const warnings: Warning[] = [];
  const add = (config: string, group: string, artifact: string, version: string | undefined) => {
    const v = expand(version ?? '', vars);
    if (v.includes('$')) {
      warnings.push({
        code: 'unresolved-version',
        message: `${group}:${artifact}: cannot resolve ${v}; not scanned`,
        file,
      });
      return;
    }
    deps.push({
      name: `${group}:${artifact}`,
      version: v,
      scope: isTestConfig(config) ? 'dev' : 'prod',
    });
  };

  // implementation 'g:a:v'  |  implementation("g:a:v")  |  testImplementation "g:a:v:classifier@jar"
  const stringNotation = new RegExp(
    `\\b(${CONFIGS})\\s*\\(?\\s*(?:platform\\(|enforcedPlatform\\()?\\s*["']([^"':\\s]+):([^"':\\s]+)(?::([^"':@\\s]+))?(?::[^"'@\\s]+)?(?:@\\w+)?["']`,
    'g',
  );
  for (const m of content.matchAll(stringNotation)) add(m[1]!, m[2]!, m[3]!, m[4]);

  // implementation group: 'g', name: 'a', version: 'v'   (version may be a bare variable)
  const mapNotation = new RegExp(
    `\\b(${CONFIGS})\\s*\\(?\\s*group\\s*[:=]\\s*["']([^"']+)["']\\s*,\\s*name\\s*[:=]\\s*["']([^"']+)["'](?:\\s*,\\s*version\\s*[:=]\\s*(?:["']([^"']+)["']|([A-Za-z_][\\w.]*)))?`,
    'g',
  );
  for (const m of content.matchAll(mapNotation))
    add(m[1]!, m[2]!, m[3]!, m[4] ?? (m[5] ? `\${${m[5]}}` : undefined));
  return { deps, warnings };
}

interface Catalog {
  versions?: Record<string, string | { strictly?: string; require?: string; prefer?: string }>;
  libraries?: Record<
    string,
    | string
    | {
        module?: string;
        group?: string;
        name?: string;
        version?: string | { ref?: string; strictly?: string; require?: string; prefer?: string };
      }
  >;
}

/** gradle/libs.versions.toml: every library in the catalog is treated as declared. */
export function parseVersionCatalog(
  content: string,
  file: string,
): { deps: DeclaredDep[]; warnings: Warning[] } {
  let doc: Catalog;
  try {
    doc = parseToml(content) as Catalog;
  } catch (e) {
    throw new Error(`${file}: invalid TOML (${(e as Error).message})`, { cause: e });
  }
  const versionOf = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as { ref?: string; strictly?: string; require?: string; prefer?: string };
      if (o.ref) return versionOf(doc.versions?.[o.ref]);
      return o.strictly ?? o.require ?? o.prefer;
    }
    return undefined;
  };
  const deps: DeclaredDep[] = [];
  for (const lib of Object.values(doc.libraries ?? {})) {
    if (typeof lib === 'string') {
      const [g, a, v] = lib.split(':');
      if (g && a) deps.push({ name: `${g}:${a}`, version: v ?? '', scope: 'prod' });
      continue;
    }
    const module = lib.module ?? (lib.group && lib.name ? `${lib.group}:${lib.name}` : undefined);
    if (module) deps.push({ name: module, version: versionOf(lib.version) ?? '', scope: 'prod' });
  }
  return { deps, warnings: [] };
}

/**
 * gradle.lockfile: `group:artifact:version=conf1,conf2`. It holds the full
 * resolved classpath but no edges; declared dependencies mark what is direct.
 */
export function parseGradleLockfile(
  content: string,
  sourceFile: string,
  rootName: string,
  declared: DeclaredDep[] | undefined,
): { graph: DependencyGraph; warnings: Warning[] } {
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  const directNames = declared ? new Set(declared.map((d) => d.name)) : undefined;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('empty=')) continue;
    const m = /^([^:\s]+):([^:\s]+):([^=\s]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, group, artifact, version, configs] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!mavenVersioning.isValid(version)) continue;
    const confs = configs.split(',').filter(Boolean);
    const name = `${group}:${artifact}`;
    const id = addNode(graph, {
      ecosystem: 'Maven',
      name,
      version,
      isDirect: directNames ? directNames.has(name) : true,
      sourceFile,
      confidence: 'high',
      scope: confs.length > 0 && confs.every(isTestConfig) ? 'dev' : 'prod',
    });
    addEdge(graph, ROOT_ID, id);
  }
  if (!directNames) {
    warnings.push({
      code: 'direct-unknown',
      message:
        'gradle.lockfile without a build file: direct and transitive dependencies cannot be told apart',
      file: sourceFile,
    });
  }
  return { graph, warnings };
}

/** Manifest-only graph from declared dependencies. */
export function declaredGraph(
  declared: DeclaredDep[],
  sourceFile: string,
  rootName: string,
  warnings: Warning[],
) {
  const graph = createGraph(rootName);
  for (const d of declared) {
    if (!d.version) {
      warnings.push({
        code: 'unresolved-version',
        message: `${d.name}: no version (managed by a platform/BOM); not scanned`,
        file: sourceFile,
      });
      continue;
    }
    const exact = mavenVersioning.isValid(d.version) && !d.version.includes('+');
    const id = addNode(graph, {
      ecosystem: 'Maven',
      name: d.name,
      version: exact ? d.version : '',
      ...(exact ? {} : { declaredRange: d.version }),
      isDirect: true,
      sourceFile,
      confidence: exact ? 'high' : 'medium',
      scope: d.scope,
    });
    addEdge(graph, ROOT_ID, id);
  }
  warnings.push({
    code: 'direct-only',
    message:
      'Build files list direct dependencies only; transitive dependencies are not scanned. Enable Gradle dependency locking (gradle.lockfile) for full coverage.',
    file: sourceFile,
  });
  return { graph, warnings };
}
