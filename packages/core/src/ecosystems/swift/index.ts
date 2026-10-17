import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { DependencyGraph, Subproject, Warning } from '../../model/types.js';
import { basename, joinPath } from '../../sources/file-provider.js';
import { SUPPORTED_FILES } from '../files.js';
import type { EcosystemPlugin } from '../types.js';
import { swiftVersioning } from './versioning.js';

interface Pin {
  identity?: string;
  package?: string;
  location?: string;
  repositoryURL?: string;
  state?: { version?: string | null };
}

/** `https://github.com/apple/swift-nio.git` → `github.com/apple/swift-nio` (OSV's SwiftURL name). */
export function normalizeSwiftUrl(url: string): string {
  return url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]+@(?=[^/:]+[:/])/, '')
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
}

/** URLs of `.package(url: "…")` declarations in Package.swift. */
export function parsePackageSwift(content: string): Set<string> {
  const urls = new Set<string>();
  for (const m of content.matchAll(/\.package\s*\([^)]*?url:\s*"([^"]+)"/g)) {
    urls.add(normalizeSwiftUrl(m[1]!));
  }
  return urls;
}

/**
 * Package.resolved v1 (`object.pins[]` with `repositoryURL`) and v2/v3 (`pins[]` with
 * `location`). The file has no edges, so everything hangs off the root; Package.swift
 * (when given) tells which pins are direct.
 */
export function parsePackageResolved(
  content: string,
  sourceFile: string,
  rootName: string,
  declared?: Set<string>,
): { graph: DependencyGraph; warnings: Warning[] } {
  const graph = createGraph(rootName);
  const warnings: Warning[] = [];
  const bad = (message: string) => {
    warnings.push({
      code: 'malformed-lockfile',
      message: `${sourceFile}: ${message}`,
      file: sourceFile,
    });
    return { graph, warnings };
  };
  let doc: { version?: number; pins?: Pin[]; object?: { pins?: Pin[] } } | null;
  try {
    doc = JSON.parse(content) as typeof doc;
  } catch (e) {
    return bad(`invalid JSON (${(e as Error).message})`);
  }
  const pins = doc?.pins ?? doc?.object?.pins;
  if (!Array.isArray(pins)) return bad('no "pins" array');

  const useDeclared = declared !== undefined && declared.size > 0;
  for (const pin of pins) {
    const location = pin?.location ?? pin?.repositoryURL;
    const label = pin?.identity ?? pin?.package ?? location ?? 'unknown';
    const version = pin?.state?.version?.replace(/^v(?=\d)/, '');
    if (!location || /^(\/|file:|\.)/.test(location)) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${label}: not a remote repository`,
        file: sourceFile,
      });
      continue;
    }
    if (!version || !swiftVersioning.isValid(version)) {
      warnings.push({
        code: 'non-registry-version',
        message: `Skipping ${label}: pinned to a branch or revision, not a release`,
        file: sourceFile,
      });
      continue;
    }
    const name = normalizeSwiftUrl(location);
    const id = addNode(graph, {
      ecosystem: 'SwiftURL',
      name,
      version,
      isDirect: useDeclared ? declared.has(name) : true,
      sourceFile,
      confidence: 'high',
      scope: 'prod',
    });
    addEdge(graph, ROOT_ID, id);
  }
  return { graph, warnings };
}

export const swiftPlugin: EcosystemPlugin = {
  id: 'SwiftURL',
  displayName: 'Swift Package Manager',
  files: SUPPORTED_FILES.SwiftURL,
  versioning: swiftVersioning,
  normalizeName: normalizeSwiftUrl,

  async parse({ dir, files, provider, allFiles }) {
    if (!files.some((f) => basename(f) === 'Package.resolved')) {
      return { subprojects: [], warnings: [] };
    }
    const lockPath = joinPath(dir, 'Package.resolved');
    const manifestPath = joinPath(dir, 'Package.swift');
    const manifest = allFiles.includes(manifestPath)
      ? await provider.read(manifestPath).catch(() => undefined)
      : undefined;
    const { graph, warnings } = parsePackageResolved(
      await provider.read(lockPath),
      lockPath,
      dir ? basename(dir) : 'root',
      manifest ? parsePackageSwift(manifest) : undefined,
    );
    const sub: Subproject = { path: dir, ecosystem: 'SwiftURL', graph, warnings };
    return { subprojects: [sub], warnings: [] };
  },
};
