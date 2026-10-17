import { DEFAULT_TTL_SECONDS } from '../../cache/types.js';
import type { Subproject, Warning } from '../../model/types.js';
import { basename, joinPath } from '../../sources/file-provider.js';
import type { EcosystemPlugin } from '../types.js';
import {
  declaredGraph,
  parseGradleBuild,
  parseGradleLockfile,
  parseVersionCatalog,
  type DeclaredDep,
} from './gradle.js';
import { loadPomChain, pomGraph } from './pom.js';
import { isPrerelease, parseMavenRange } from './ranges.js';
import { compareMaven, mavenVersioning } from './versioning.js';
import { SUPPORTED_FILES } from '../files.js';

const MAVEN_CENTRAL = 'https://repo1.maven.org/maven2';

export const mavenPlugin: EcosystemPlugin = {
  id: 'Maven',
  displayName: 'Maven / Gradle',
  files: SUPPORTED_FILES.Maven,
  versioning: mavenVersioning,

  async parse({ dir, files, provider }) {
    const names = new Set(files.map(basename));
    const rootName = dir ? basename(dir) : 'root';
    const warnings: Warning[] = [];

    // Gradle: declared deps from the build script plus the version catalog, if any.
    let declared: DeclaredDep[] | undefined;
    let buildFile: string | undefined;
    for (const name of ['build.gradle.kts', 'build.gradle']) {
      if (!names.has(name)) continue;
      buildFile = joinPath(dir, name);
      const parsed = parseGradleBuild(await provider.read(buildFile), buildFile);
      declared = parsed.deps;
      warnings.push(...parsed.warnings);
      const catalogPath = joinPath(dir, 'gradle/libs.versions.toml');
      const catalog = await provider.read(catalogPath).catch(() => undefined);
      if (catalog !== undefined) declared.push(...parseVersionCatalog(catalog, catalogPath).deps);
      break;
    }

    let result;
    if (names.has('gradle.lockfile')) {
      const lockPath = joinPath(dir, 'gradle.lockfile');
      result = parseGradleLockfile(await provider.read(lockPath), lockPath, rootName, declared);
    } else if (names.has('pom.xml')) {
      const pomPath = joinPath(dir, 'pom.xml');
      const chain = await loadPomChain(pomPath, provider);
      // Aggregator POMs (packaging=pom, no dependencies) only list modules.
      if (chain[0]!.packaging === 'pom' && !chain[0]!.dependencies)
        return { subprojects: [], warnings };
      result = pomGraph(chain, pomPath, rootName);
    } else if (declared && buildFile) {
      result = declaredGraph(declared, buildFile, rootName, []);
    } else {
      return { subprojects: [], warnings };
    }
    const sub: Subproject = {
      path: dir,
      ecosystem: 'Maven',
      graph: result.graph,
      warnings: [...warnings, ...result.warnings],
    };
    return { subprojects: [sub], warnings: [] };
  },

  async resolveRange(name, range, net) {
    const matches = parseMavenRange(range);
    if (!matches) return null;
    const [group, artifact] = name.split(':');
    if (!group || !artifact) return null;
    const key = `maven-metadata:${name}`;
    let versions = await net.cache.get<string[]>(key);
    if (!versions) {
      const url = `${MAVEN_CENTRAL}/${group.replace(/\./g, '/')}/${artifact}/maven-metadata.xml`;
      const response = await net.fetch(url, {
        headers: { 'user-agent': net.userAgent },
        ...(net.signal ? { signal: net.signal } : {}),
      });
      if (!response.ok) return null;
      const xml = await response.text();
      versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]!.trim());
      await net.cache.set(key, versions, DEFAULT_TTL_SECONDS);
    }
    const stable = range.includes('integration')
      ? versions
      : versions.filter((v) => !isPrerelease(v));
    return stable.filter(matches).sort(compareMaven).at(-1) ?? null;
  },
};
