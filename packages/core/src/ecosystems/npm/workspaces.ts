import { joinPath } from '../../sources/file-provider.js';
import type { FileProvider } from '../../sources/file-provider.js';
import { readPackageJson, type PackageJson } from './package-json.js';
import type { WorkspaceManifest } from './yarn-lock.js';

/** `packages/*` → regex over folder paths. `*` is one segment, `**` any depth. */
export function workspaceGlobToRegExp(glob: string): RegExp {
  const clean = glob.replace(/^\.\//, '').replace(/\/$/, '');
  const re = clean
    .split('/')
    .map((seg) =>
      seg === '**' ? '.*' : seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
    )
    .join('/');
  return new RegExp(`^${re}$`);
}

export function workspacePatterns(pkg: PackageJson & { workspaces?: unknown }): string[] {
  const ws = pkg.workspaces;
  if (Array.isArray(ws)) return ws.filter((x): x is string => typeof x === 'string');
  if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
    return (ws as { packages: unknown[] }).packages.filter(
      (x): x is string => typeof x === 'string',
    );
  }
  return [];
}

/** Folders (relative to `dir`) matched by the root package.json `workspaces` field. */
export function workspaceDirs(dir: string, patterns: string[], allFiles: string[]): string[] {
  if (patterns.length === 0) return [];
  const regexes = patterns.filter((p) => !p.startsWith('!')).map(workspaceGlobToRegExp);
  const prefix = dir ? `${dir}/` : '';
  const out: string[] = [];
  for (const file of allFiles) {
    if (!file.startsWith(prefix) || !file.endsWith('/package.json')) continue;
    const rel = file.slice(prefix.length, -'/package.json'.length);
    if (regexes.some((r) => r.test(rel))) out.push(rel);
  }
  return out.sort();
}

function toManifest(path: string, pkg: PackageJson): WorkspaceManifest {
  const m: WorkspaceManifest = {
    path,
    dependencies: { ...pkg.dependencies, ...pkg.optionalDependencies },
    devDependencies: { ...pkg.devDependencies },
  };
  if (pkg.name) m.name = pkg.name;
  return m;
}

/** Root manifest plus every workspace member's manifest. */
export async function loadWorkspaceManifests(
  dir: string,
  root: PackageJson | undefined,
  allFiles: string[],
  provider: FileProvider,
): Promise<WorkspaceManifest[]> {
  if (!root) return [];
  const manifests = [toManifest('', root)];
  for (const rel of workspaceDirs(dir, workspacePatterns(root), allFiles)) {
    const path = joinPath(dir, `${rel}/package.json`);
    try {
      manifests.push(toManifest(rel, readPackageJson(await provider.read(path), path)));
    } catch {
      // An unreadable member just contributes no direct dependencies.
    }
  }
  return manifests;
}
