import type { Ecosystem } from '../model/types.js';

/**
 * File names each ecosystem understands. Kept apart from the parsers so UIs can
 * check uploads without bundling YAML/TOML/XML parsers.
 */
export const SUPPORTED_FILES: Record<
  Ecosystem,
  { lock: string[]; manifest: string[]; context: string[] }
> = {
  npm: {
    // Priority order: npm-shrinkwrap.json wins over package-lock.json (npm docs).
    lock: ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
    manifest: ['package.json'],
    context: [],
  },
  PyPI: {
    lock: ['poetry.lock', 'uv.lock', 'Pipfile.lock', 'requirements*.txt'],
    manifest: ['pyproject.toml', 'Pipfile'],
    context: [],
  },
  Packagist: { lock: ['composer.lock'], manifest: ['composer.json'], context: [] },
  Maven: {
    lock: ['gradle.lockfile'],
    manifest: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    // Read alongside the build file when present.
    context: ['libs.versions.toml'],
  },
  // go.mod pins exact versions of the whole module graph (Go ≥ 1.17), so it acts as the lock.
  Go: { lock: ['go.mod'], manifest: [], context: [] },
  NuGet: {
    lock: ['packages.lock.json', 'packages.config'],
    manifest: ['*.csproj', '*.fsproj', '*.vbproj'],
    context: ['Directory.Packages.props'],
  },
};

/** Every file name (or `*` pattern) worth uploading, across ecosystems. */
export const ALL_SUPPORTED_PATTERNS: string[] = Object.values(SUPPORTED_FILES).flatMap((f) => [
  ...f.lock,
  ...f.manifest,
  ...f.context,
]);
