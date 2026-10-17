import semver from 'semver';
import { DEFAULT_TTL_SECONDS } from '../../cache/types.js';
import { fetchJson } from '../../net/http.js';
import { basename, joinPath } from '../../sources/file-provider.js';
import type { Subproject, Warning } from '../../model/types.js';
import type { EcosystemPlugin } from '../types.js';
import {
  directDependencyNames,
  parsePackageJsonManifest,
  readPackageJson,
} from './package-json.js';
import { parsePackageLock, type LockParseResult } from './package-lock.js';
import { parsePnpmLock, pnpmHasImporter } from './pnpm-lock.js';
import { loadWorkspaceManifests, workspaceGlobToRegExp, workspacePatterns } from './workspaces.js';
import { parseYarnLock } from './yarn-lock.js';
import { npmVersioning } from './versioning.js';
import { SUPPORTED_FILES } from '../files.js';

interface RegistryVersions {
  versions: string[];
  tags: Record<string, string>;
}

const REGISTRY = 'https://registry.npmjs.org';

const LOCK_FILES = SUPPORTED_FILES.npm.lock;

function rootNameFor(dir: string): string {
  return dir ? basename(dir) : 'root';
}

export const npmPlugin: EcosystemPlugin = {
  id: 'npm',
  displayName: 'npm',
  files: SUPPORTED_FILES.npm,
  versioning: npmVersioning,

  async parse({ dir, files, provider, allFiles }) {
    const warnings: Warning[] = [];
    const names = new Set(files.map(basename));
    const manifestPath = joinPath(dir, 'package.json');
    const pkg = names.has('package.json')
      ? readPackageJson(await provider.read(manifestPath), manifestPath)
      : undefined;
    const rootName = pkg?.name || rootNameFor(dir);

    const locks = LOCK_FILES.filter((n) => names.has(n));
    if (locks.length > 1) {
      warnings.push({
        code: 'multiple-lockfiles',
        message: `Several lock files found (${locks.join(', ')}); using ${locks[0]}`,
        file: joinPath(dir, locks[0]!),
      });
    }

    const lockName = locks[0];
    let result: LockParseResult;
    if (lockName) {
      const sourceFile = joinPath(dir, lockName);
      const content = await provider.read(sourceFile);
      if (lockName === 'pnpm-lock.yaml') {
        result = parsePnpmLock(content, sourceFile, rootName);
      } else if (lockName === 'yarn.lock') {
        const manifests = await loadWorkspaceManifests(dir, pkg, allFiles, provider);
        result = parseYarnLock(content, sourceFile, rootName, manifests);
      } else {
        result = parsePackageLock(
          content,
          sourceFile,
          rootName,
          pkg ? directDependencyNames(pkg) : undefined,
        );
      }
    } else if (pkg) {
      result = parsePackageJsonManifest(pkg, manifestPath, rootNameFor(dir));
    } else {
      return { subprojects: [], warnings };
    }
    const subproject: Subproject = {
      path: dir,
      ecosystem: 'npm',
      graph: result.graph,
      warnings: result.warnings,
    };
    return { subprojects: [subproject], warnings };
  },

  async isCoveredByLock(lockDir, memberDir, provider) {
    const rel = lockDir ? memberDir.slice(lockDir.length + 1) : memberDir;
    for (const name of LOCK_FILES) {
      const content = await provider.read(joinPath(lockDir, name)).catch(() => undefined);
      if (content === undefined) continue;
      if (name === 'pnpm-lock.yaml') return pnpmHasImporter(content, rel);
      if (name === 'yarn.lock') {
        // Yarn locks don't list members; the root package.json workspaces field does.
        const rootPkg = await provider.read(joinPath(lockDir, 'package.json')).catch(() => '{}');
        const patterns = workspacePatterns(JSON.parse(rootPkg) as object);
        return patterns.some((p) => workspaceGlobToRegExp(p).test(rel));
      }
      // v2+ package locks list each workspace folder under `packages`; v1 had no workspaces.
      const lock = JSON.parse(content) as { packages?: Record<string, unknown> };
      return Boolean(lock.packages?.[rel]);
    }
    return false;
  },

  async resolveRange(name, range, net) {
    const key = `npm-registry:${name}`;
    let data = await net.cache.get<RegistryVersions>(key);
    if (!data) {
      const raw = await fetchJson<{
        versions?: Record<string, unknown>;
        'dist-tags'?: Record<string, string>;
      }>(
        net.fetch,
        `${REGISTRY}/${name.replace('/', '%2f')}`,
        { headers: { accept: 'application/vnd.npm.install-v1+json' } },
        net.signal ? { signal: net.signal } : {},
      );
      data = { versions: Object.keys(raw.versions ?? {}), tags: raw['dist-tags'] ?? {} };
      await net.cache.set(key, data, DEFAULT_TTL_SECONDS);
    }
    // What a fresh `npm install` would pick: the `latest` tag if it satisfies, else the max match.
    const latest = data.tags.latest;
    if (data.tags[range]) return data.tags[range]!;
    if (latest && semver.satisfies(latest, range, { loose: true })) return latest;
    return semver.maxSatisfying(data.versions, range, { loose: true });
  },
};
