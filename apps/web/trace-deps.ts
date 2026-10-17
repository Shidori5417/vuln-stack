import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

interface Manifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const inNodeModules = (p: string) => p.includes('/node_modules/');

/** Finds `name` the way Node would: walking up `node_modules` directories. */
function locate(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Globs (relative to `base`) covering a package and its production dependency
 * closure, for `outputFileTracingIncludes`. Next's file tracing cannot follow
 * the native dynamic import of @vulnstack/db (see src/server/store.ts), so the
 * packages it needs at runtime are listed explicitly. Both the pnpm symlink
 * location (what `require` resolves through) and the real directory are listed;
 * workspace packages contribute only their built output, never src/test/dev deps.
 */
export function productionClosureGlobs(pkgDir: string, base: string): string[] {
  const globs = new Set<string>();
  const seen = new Set<string>();
  const rel = (p: string) => relative(base, p).split('\\').join('/');

  const visit = (dir: string) => {
    const real = realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    if (!inNodeModules(real)) {
      for (const sub of ['dist', 'drizzle']) globs.add(`${rel(real)}/${sub}/**`);
      globs.add(`${rel(real)}/package.json`);
    } else {
      globs.add(`${rel(real)}/**`);
    }
    const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as Manifest;
    const deps = { ...manifest.optionalDependencies, ...manifest.dependencies };
    for (const name of Object.keys(deps)) {
      const found = locate(name, real);
      if (!found) continue; // optional dependency not installed on this platform
      // The symlink itself, so `require` resolves; never for workspace packages,
      // whose link would expand to the whole source tree (src, test, coverage, ...).
      if (realpathSync(found) !== found) {
        globs.add(
          inNodeModules(realpathSync(found)) ? `${rel(found)}/**` : `${rel(found)}/package.json`,
        );
      }
      visit(found);
    }
  };

  visit(pkgDir);
  return [...globs].sort();
}
