export * from './model/types.js';
export {
  ROOT_ID,
  addEdge,
  addNode,
  assignScopesByReachability,
  chainNames,
  computePaths,
  createGraph,
  nodeId,
} from './model/graph.js';

// Ecosystems
export type {
  EcosystemPlugin,
  ManifestFiles,
  ParseInput,
  ParseOutput,
  Versioning,
} from './ecosystems/types.js';
export { defaultPlugins, pluginFor } from './ecosystems/registry.js';
export { ALL_SUPPORTED_PATTERNS, SUPPORTED_FILES } from './ecosystems/files.js';
export { npmPlugin } from './ecosystems/npm/index.js';
export { npmVersioning } from './ecosystems/npm/versioning.js';
export { pypiPlugin } from './ecosystems/pypi/index.js';
export { normalizePypiName, pypiVersioning } from './ecosystems/pypi/versioning.js';
export { packagistPlugin } from './ecosystems/packagist/index.js';
export { packagistVersioning } from './ecosystems/packagist/versioning.js';
export { mavenPlugin } from './ecosystems/maven/index.js';
export { mavenVersioning } from './ecosystems/maven/versioning.js';
export { goPlugin } from './ecosystems/go/index.js';
export { goVersioning } from './ecosystems/go/versioning.js';
export { nugetPlugin } from './ecosystems/nuget/index.js';
export { nugetVersioning } from './ecosystems/nuget/versioning.js';

// Inputs
export { MemoryFileProvider, type FileProvider } from './sources/file-provider.js';
export {
  collectSubprojects,
  discoverProjects,
  dropWorkspaceMembers,
  isIgnoredPath,
  IGNORED_DIRS,
} from './sources/discover.js';
export { matchesAny, matchesName } from './sources/match.js';
export {
  guessEcosystem,
  manualSubprojects,
  parseManualInput,
  type ManualEntry,
} from './sources/manual.js';

// Caching and networking
export type { CacheStore } from './cache/types.js';
export { DEFAULT_TTL_SECONDS } from './cache/types.js';
export { MemoryCache } from './cache/memory.js';
export {
  FallbackCache,
  fromIoredis,
  fromNodeRedis,
  RedisCache,
  type RedisCommands,
} from './cache/redis.js';
export type { FetchFn, NetContext } from './net/context.js';
export { HttpError, fetchJson } from './net/http.js';
export { SlidingWindowLimiter, realClock, type Clock } from './net/rate-limit.js';

// Advisories
export {
  OsvClient,
  type OsvClientOptions,
  type OsvRecord,
  type PackageQuery,
} from './advisories/osv.js';
export { GhsaClient, ghsaRangeToEvents } from './advisories/ghsa.js';
export { NvdClient, type NvdOptions } from './advisories/nvd.js';
export { advisoryUrl, canonicalId, mergeRecords } from './advisories/merge.js';
export { parseCvss, severityFromLabel, severityFromScore } from './advisories/cvss.js';
export { computeRemediation, evaluateRange, recordAffects } from './remediation.js';

// Scanning and reports
export {
  compareFindings,
  fingerprintOf,
  scanFiles,
  scanManual,
  scanSubprojects,
  summarize,
  type ScanOptions,
  type ScanPhase,
} from './scan.js';
export { formatJson, toJsonReport, type JsonReport } from './report/json.js';
export { formatSarif, toSarif } from './report/sarif.js';
export { renderPdfReport, type PdfReportOptions } from './report/pdf/report.js';
export {
  applyIgnores,
  exceedsThreshold,
  FAIL_LEVELS,
  ignoreRulesFromIds,
  parseIgnoreFile,
  type FailLevel,
  type IgnoreRule,
  type IgnoredFinding,
} from './ignore.js';
export { VERSION } from './version.js';

// GitHub source
export {
  GitHubFileProvider,
  parseGitHubUrl,
  scanGitHubRepo,
  type GitHubProviderOptions,
  type GitHubRef,
  type GitHubScanOptions,
} from './sources/github.js';

// Passive website fingerprinting (server-side use; see net/ssrf.ts)
export {
  SsrfError,
  assertPublicUrl,
  isBlockedIp,
  safeFetch,
  type Resolver,
  type SafeFetchOptions,
  type SafeResponse,
} from './net/ssrf.js';
export {
  fingerprintSite,
  type Detected,
  type FingerprintOptions,
  type FingerprintResult,
} from './fingerprint/detect.js';
export {
  BUILTIN_SIGNATURES,
  type Signature,
  type SignatureMatch,
} from './fingerprint/signatures.js';
export {
  RETIRE_REPOSITORY_URL,
  loadRetireSignatures,
  parseRetireRepository,
} from './fingerprint/retire.js';
export { scanWebsite, type WebsiteScanOptions } from './fingerprint/scan-website.js';
export {
  OfflineDatabase,
  OfflineIndexBuilder,
  buildOfflineIndex,
  type OfflineIndex,
} from './offline/index.js';
export { readZip, ZipError, type InflateRaw, type ZipEntry } from './offline/zip.js';
