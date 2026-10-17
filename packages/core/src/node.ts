export { FsFileProvider, type FsProviderOptions } from './node/fs-provider.js';
export { FileCache, defaultCacheDir } from './node/file-cache.js';
export { nodeResolve } from './node/resolve.js';
export {
  MAX_DUMP_BYTES,
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
