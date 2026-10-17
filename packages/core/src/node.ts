export { FsFileProvider, type FsProviderOptions } from './node/fs-provider.js';
export { FileCache, defaultCacheDir } from './node/file-cache.js';
export { nodeResolve } from './node/resolve.js';
export {
  EPSS_DUMP_URL,
  KEV_DUMP_URL,
  MAX_DUMP_BYTES,
  loadExploitData,
  parseEpssGzip,
  readExploitMeta,
  updateExploitData,
  type ExploitMeta,
  type ExploitMetaEntry,
  type UpdateExploitOptions,
  type UpdateExploitResult,
  OSV_DUMP_BASE,
  defaultOfflineDir,
  LazyOfflineDatabase,
  loadOfflineDatabase,
  openOfflineDatabase,
  readOfflineMeta,
  updateOfflineDatabase,
  type OfflineMeta,
  type OfflineMetaEntry,
  type UpdateOfflineOptions,
  type UpdateOfflineResult,
} from './node/offline.js';
