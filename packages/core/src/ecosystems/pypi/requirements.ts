import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, DependencyScope, Warning } from '../../model/types.js';
import { dirname, joinPath, type FileProvider } from '../../sources/file-provider.js';
import { exactVersion, parseRequirement } from './pep508.js';
import { normalizePypiName } from './versioning.js';

interface RequirementLine {
  name: string;
  spec: string;
  file: string;
  /** From pip-compile `# via` annotations. */
  via: string[];
}

const DEV_FILE = /(dev|test|lint|doc|ci|typing)/i;
const MAX_INCLUDE_DEPTH = 5;

/** Joins `\` continuations and returns logical lines with their trailing comments kept. */
function logicalLines(content: string): string[] {
  return content.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
}

async function readRequirements(
  path: string,
  provider: FileProvider,
  warnings: Warning[],
  seen: Set<string>,
  depth: number,
): Promise<RequirementLine[]> {
  if (seen.has(path) || depth > MAX_INCLUDE_DEPTH) return [];
  seen.add(path);
  const content = await provider.read(path);
  const out: RequirementLine[] = [];
  let last: RequirementLine | undefined;
  let inVia = false;

  for (const raw of logicalLines(content)) {
    const trimmed = raw.trim();
    // pip-compile annotations: "    # via flask" or a "# via" header followed by "#   pkg" lines
    if (trimmed.startsWith('#')) {
      const via = /^#\s*via\s*(.*)$/.exec(trimmed);
      if (via && last) {
        inVia = true;
        if (via[1]) last.via.push(via[1].trim());
      } else if (inVia && last && /^#\s{2,}\S/.test(trimmed)) {
        last.via.push(trimmed.replace(/^#\s+/, ''));
      } else {
        inVia = false;
      }
      continue;
    }
    inVia = false;
    const line = trimmed.replace(/\s+#.*$/, '');
    if (!line) continue;

    const include = /^(-r|--requirement|-c|--constraint)\s*=?\s*(\S+)/.exec(line);
    if (include) {
      if (include[1] === '-c' || include[1] === '--constraint') continue; // constraints don't add packages
      const target = joinPath(dirname(path), include[2]!);
      try {
        out.push(...(await readRequirements(target, provider, warnings, seen, depth + 1)));
      } catch {
        warnings.push({
          code: 'missing-include',
          message: `Cannot read included file ${include[2]}`,
          file: path,
        });
      }
      continue;
    }
    if (line.startsWith('-e') || line.startsWith('--editable')) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping editable install: ${line}`,
        file: path,
      });
      continue;
    }
    if (line.startsWith('-')) continue; // --index-url, --hash, --find-links …

    const req = parseRequirement(line.replace(/\s--hash=\S+/g, ''));
    if (!req || req.url) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping unsupported requirement: ${line}`,
        file: path,
      });
      continue;
    }
    last = { name: req.name, spec: req.spec, file: path, via: [] };
    out.push(last);
  }
  return out;
}

/**
 * Parses every requirements file of a folder into one graph. Pinned (`==`)
 * entries are exact; others keep their range for later resolution.
 */
export async function parseRequirementsFiles(
  files: string[],
  provider: FileProvider,
  rootName: string,
): Promise<{ graph: DependencyGraph; warnings: Warning[] }> {
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  const seen = new Set<string>();
  const lines: { line: RequirementLine; scope: DependencyScope }[] = [];
  for (const file of files) {
    const scope: DependencyScope = DEV_FILE.test(file.slice(file.lastIndexOf('/') + 1))
      ? 'dev'
      : 'prod';
    for (const line of await readRequirements(file, provider, warnings, seen, 0))
      lines.push({ line, scope });
  }

  const annotated = lines.some(({ line }) => line.via.length > 0);
  const ids = new Map<string, string>();
  for (const { line, scope } of lines) {
    const version = exactVersion(line.spec);
    const id = addNode(graph, {
      ecosystem: 'PyPI',
      name: line.name,
      version: version ?? '',
      ...(version ? {} : { declaredRange: line.spec || '*' }),
      isDirect: !annotated,
      sourceFile: line.file,
      confidence: version ? 'high' : 'medium',
      scope,
    });
    ids.set(line.name, id);
  }

  for (const { line } of lines) {
    const id = ids.get(line.name)!;
    if (!annotated) {
      addEdge(graph, ROOT_ID, id);
      continue;
    }
    for (const via of line.via) {
      if (
        via.startsWith('-r') ||
        via.startsWith('-c') ||
        via.endsWith('.in') ||
        via.endsWith('.toml')
      ) {
        graph.nodes.get(id)!.isDirect = true;
        addEdge(graph, ROOT_ID, id);
      } else {
        const parent = ids.get(normalizePypiName(via.split(/\s/)[0]!));
        if (parent) addEdge(graph, parent, id);
      }
    }
  }
  // Annotated files where something has no usable `via` still need a path from the root.
  if (annotated) {
    const reached = new Set<string>();
    for (const children of graph.edges.values()) for (const c of children) reached.add(c);
    for (const { line } of lines) {
      const id = ids.get(line.name)!;
      if (!reached.has(id)) {
        graph.nodes.get(id)!.isDirect = true;
        addEdge(graph, ROOT_ID, id);
      }
    }
  }
  if (lines.some(({ line }) => !exactVersion(line.spec))) {
    warnings.push({
      code: 'unpinned-requirements',
      message:
        'Some requirements are not pinned with ==; their versions are estimated from the package index',
      file: files[0]!,
    });
  }
  return { graph, warnings };
}
