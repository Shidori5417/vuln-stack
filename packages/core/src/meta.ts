/**
 * Browser-safe subset of @vulnstack/core: types, supported file names and
 * manual-input parsing. No parsers, no network code.
 */
export * from './model/types.js';
export { ALL_SUPPORTED_PATTERNS, SUPPORTED_FILES } from './ecosystems/files.js';
export { matchesAny, matchesName } from './sources/match.js';
export { guessEcosystem, parseManualInput, type ManualEntry } from './sources/manual.js';
export { advisoryUrl } from './advisories/urls.js';
export { VERSION } from './version.js';
export { exploitRank, formatEpss, isKnownExploited } from './model/exploit.js';
