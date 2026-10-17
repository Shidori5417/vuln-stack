import type { Subproject, Warning } from '../model/types.js';
import { defaultPlugins } from '../ecosystems/registry.js';
import type { EcosystemPlugin } from '../ecosystems/types.js';
import { basename, dirname, type FileProvider } from './file-provider.js';
import { matchesAny } from './match.js';

export { matchesAny, matchesName } from './match.js';

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'vendor',
  'bower_components',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  'target',
  '_build',
  '.build',
  '.dart_tool',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
]);

export function isIgnoredPath(path: string): boolean {
  return path.split('/').some((segment) => IGNORED_DIRS.has(segment));
}

export interface DiscoveredProject {
  dir: string;
  plugin: EcosystemPlugin;
  files: string[];
  hasLock: boolean;
}

/** Groups supported files by folder and plugin; lock files mark `hasLock`. */
export function discoverProjects(
  paths: string[],
  plugins: readonly EcosystemPlugin[] = defaultPlugins,
): DiscoveredProject[] {
  const found = new Map<string, DiscoveredProject>();

  for (const path of paths) {
    if (isIgnoredPath(path)) continue;
    const name = basename(path);
    const dir = dirname(path);
    for (const plugin of plugins) {
      const isLock = matchesAny(plugin.files.lock, name);
      if (!isLock && !matchesAny(plugin.files.manifest, name)) continue;
      const key = `${plugin.id}\0${dir}`;
      let project = found.get(key);
      if (!project) {
        project = { dir, plugin, files: [], hasLock: false };
        found.set(key, project);
      }
      project.files.push(path);
      if (isLock) project.hasLock = true;
    }
  }

  return [...found.values()].sort(
    (a, b) => a.dir.localeCompare(b.dir) || a.plugin.id.localeCompare(b.plugin.id),
  );
}

const isAncestor = (ancestor: string, dir: string) =>
  ancestor !== dir && (ancestor === '' || dir.startsWith(`${ancestor}/`));

/**
 * Drops manifest-only folders that a workspace lock higher up already covers
 * (npm/pnpm/yarn workspaces). Independent nested projects are kept.
 */
export async function dropWorkspaceMembers(
  projects: DiscoveredProject[],
  provider: FileProvider,
): Promise<DiscoveredProject[]> {
  const kept: DiscoveredProject[] = [];
  for (const project of projects) {
    const check = project.plugin.isCoveredByLock;
    if (!project.hasLock && check) {
      // Nearest ancestor first.
      const locks = projects
        .filter(
          (p) => p.hasLock && p.plugin.id === project.plugin.id && isAncestor(p.dir, project.dir),
        )
        .sort((a, b) => b.dir.length - a.dir.length);
      let covered = false;
      for (const lock of locks) {
        if (await check.call(project.plugin, lock.dir, project.dir, provider).catch(() => false)) {
          covered = true;
          break;
        }
      }
      if (covered) continue;
    }
    kept.push(project);
  }
  return kept;
}

export interface CollectResult {
  subprojects: Subproject[];
  warnings: Warning[];
}

export async function collectSubprojects(
  provider: FileProvider,
  plugins: readonly EcosystemPlugin[] = defaultPlugins,
): Promise<CollectResult> {
  const allFiles = (await provider.list()).filter((p) => !isIgnoredPath(p));
  const discovered = await dropWorkspaceMembers(discoverProjects(allFiles, plugins), provider);
  const subprojects: Subproject[] = [];
  const warnings: Warning[] = [];

  for (const project of discovered) {
    try {
      const out = await project.plugin.parse({
        dir: project.dir,
        files: project.files,
        provider,
        allFiles,
      });
      subprojects.push(...out.subprojects);
      warnings.push(...out.warnings);
    } catch (error) {
      warnings.push({
        code: 'parse-error',
        message: (error as Error).message,
        file: project.files[0]!,
      });
    }
  }

  if (discovered.length === 0) {
    warnings.push({ code: 'no-manifests', message: 'No supported dependency files were found' });
  }
  return { subprojects, warnings };
}
