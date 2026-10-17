import * as pep440 from '@renovatebot/pep440';
import { DEFAULT_TTL_SECONDS } from '../../cache/types.js';
import { fetchJson } from '../../net/http.js';
import type { Subproject, Warning } from '../../model/types.js';
import { basename, joinPath } from '../../sources/file-provider.js';
import { matchesName } from '../../sources/match.js';
import type { EcosystemPlugin } from '../types.js';
import { parsePipfileLock, parsePoetryLock, parseUvLock } from './lockfiles.js';
import { directDepsOf, manifestGraph, readPipfile, readPyproject } from './pyproject.js';
import { parseRequirementsFiles } from './requirements.js';
import { normalizePypiName, pypiVersioning } from './versioning.js';
import { SUPPORTED_FILES } from '../files.js';

const LOCKS = ['poetry.lock', 'uv.lock', 'Pipfile.lock'];
const REQUIREMENTS = 'requirements*.txt';

const rootNameFor = (dir: string) => (dir ? basename(dir) : 'root');

export const pypiPlugin: EcosystemPlugin = {
  id: 'PyPI',
  displayName: 'PyPI',
  files: SUPPORTED_FILES.PyPI,
  versioning: pypiVersioning,
  normalizeName: normalizePypiName,

  async parse({ dir, files, provider }) {
    const names = new Set(files.map(basename));
    const read = (name: string) => provider.read(joinPath(dir, name));
    const pyproject = names.has('pyproject.toml')
      ? readPyproject(await read('pyproject.toml'), joinPath(dir, 'pyproject.toml'))
      : undefined;
    const pipfile = names.has('Pipfile')
      ? readPipfile(await read('Pipfile'), joinPath(dir, 'Pipfile'))
      : undefined;
    const rootName = pyproject?.name ?? rootNameFor(dir);
    const warnings: Warning[] = [];

    const lock = LOCKS.find((n) => names.has(n));
    const requirements = files
      .filter((f) => matchesName(REQUIREMENTS, basename(f)))
      .sort((a, b) => {
        // requirements.txt first so prod scope wins when files overlap
        const rank = (f: string) => (basename(f) === 'requirements.txt' ? 0 : 1);
        return rank(a) - rank(b) || a.localeCompare(b);
      });

    let result;
    if (lock) {
      const path = joinPath(dir, lock);
      const content = await read(lock);
      if (lock === 'poetry.lock')
        result = parsePoetryLock(content, path, rootName, pyproject && directDepsOf(pyproject));
      else if (lock === 'uv.lock') result = parseUvLock(content, path, rootName);
      else result = parsePipfileLock(content, path, rootName, pipfile && directDepsOf(pipfile));
      if (requirements.length) {
        warnings.push({
          code: 'multiple-lockfiles',
          message: `Using ${lock}; requirements files in the same folder were ignored`,
          file: path,
        });
      }
    } else if (requirements.length) {
      result = await parseRequirementsFiles(requirements, provider, rootName);
    } else if (pyproject && pyproject.deps.length) {
      result = manifestGraph(pyproject, joinPath(dir, 'pyproject.toml'), rootName);
    } else if (pipfile) {
      result = manifestGraph(pipfile, joinPath(dir, 'Pipfile'), rootName);
    } else {
      return { subprojects: [], warnings };
    }
    const sub: Subproject = {
      path: dir,
      ecosystem: 'PyPI',
      graph: result.graph,
      warnings: result.warnings,
    };
    return { subprojects: [sub], warnings };
  },

  async isCoveredByLock(lockDir, memberDir, provider) {
    // uv workspaces: members appear in the root uv.lock as editable sources.
    const content = await provider.read(joinPath(lockDir, 'uv.lock')).catch(() => undefined);
    if (!content) return false;
    const rel = lockDir ? memberDir.slice(lockDir.length + 1) : memberDir;
    return content.includes(`editable = "${rel}"`) || content.includes(`virtual = "${rel}"`);
  },

  async resolveRange(name, range, net) {
    const key = `pypi-simple:${name}`;
    let versions = await net.cache.get<string[]>(key);
    if (!versions) {
      // PEP 691 JSON simple API; `versions` comes from PEP 700.
      const data = await fetchJson<{
        versions?: string[];
        files?: { filename: string; yanked?: unknown }[];
      }>(
        net.fetch,
        `https://pypi.org/simple/${encodeURIComponent(name)}/`,
        { headers: { accept: 'application/vnd.pypi.simple.v1+json' } },
        net.signal ? { signal: net.signal } : {},
      );
      versions = (data.versions ?? []).filter((v) => pypiVersioning.isValid(v));
      await net.cache.set(key, versions, DEFAULT_TTL_SECONDS);
    }
    const spec = range === '*' ? '' : range;
    const wantsPre = /\d(a|b|rc|dev)\d*/.test(spec);
    const candidates = wantsPre
      ? versions
      : versions.filter((v) => !pep440.explain(v)?.is_prerelease);
    if (!spec) return candidates.sort(pypiVersioning.compare).at(-1) ?? null;
    return pep440.maxSatisfying(candidates, spec) ?? null;
  },
};
