import type { Ecosystem, Subproject, Warning } from '../model/types.js';
import type { FileProvider } from '../sources/file-provider.js';
import type { NetContext } from '../net/context.js';

export interface Versioning {
  /** Negative if a < b, 0 if equal, positive if a > b. Must not throw. */
  compare(a: string, b: string): number;
  isValid(version: string): boolean;
  /** True when upgrading `from` → `to` is a breaking (major) change for this ecosystem. */
  isMajorBump(from: string, to: string): boolean;
  /** Formats an advisory version the way the user writes it (e.g. Go's `v` prefix). */
  displayVersion?(version: string, current: string): string;
}

/** File names (not paths). `*` matches any run of characters, e.g. `*.csproj`. */
export interface ManifestFiles {
  /** Lock files in priority order. When any is present the manifests are only context. */
  lock: string[];
  manifest: string[];
}

export interface ParseInput {
  /** Directory of the subproject, relative to the provider root ('' for root). */
  dir: string;
  /** Matched file paths (relative to provider root), lock files first. */
  files: string[];
  provider: FileProvider;
  /** Every file the provider listed (already filtered for ignored folders). */
  allFiles: string[];
}

export interface ParseOutput {
  subprojects: Subproject[];
  warnings: Warning[];
}

/**
 * Everything VulnStack knows about an ecosystem. Adding a new ecosystem means
 * writing one of these and registering it in `ecosystems/registry.ts`.
 */
export interface EcosystemPlugin {
  id: Ecosystem;
  displayName: string;
  files: ManifestFiles;
  versioning: Versioning;
  parse(input: ParseInput): Promise<ParseOutput>;
  /**
   * Picks a concrete version for a manifest range (e.g. by asking the registry).
   * Returning null leaves the dependency unresolved.
   */
  resolveRange?(name: string, range: string, net: NetContext): Promise<string | null>;
  /**
   * True when the manifest-only folder `memberDir` is a workspace member whose
   * dependencies are already in the lock file of the ancestor folder `lockDir`.
   */
  isCoveredByLock?(lockDir: string, memberDir: string, provider: FileProvider): Promise<boolean>;
  /**
   * Canonical package name used for matching advisories (e.g. PEP 503 for PyPI).
   * Defaults to the name as written.
   */
  normalizeName?(name: string): string;
}
