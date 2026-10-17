import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { parseEpssCsv, type EpssEntry } from '../advisories/epss.js';
import type { ExploitSource } from '../advisories/exploit.js';
import { KEV_MIRROR_URL, parseKev, type KevEntry } from '../advisories/kev.js';
import type { OsvRecord } from '../advisories/osv.js';
import { ECOSYSTEMS, type Ecosystem, type Warning } from '../model/types.js';
import type { FetchFn } from '../net/context.js';
import { OfflineDatabase, OfflineIndexBuilder, type OfflineIndex } from '../offline/index.js';
import { readZip } from '../offline/zip.js';
import { defaultCacheDir } from './file-cache.js';

export const OSV_DUMP_BASE = 'https://osv-vulnerabilities.storage.googleapis.com';
/** Refuse dumps larger than this (the zip is held in memory). */
export const MAX_DUMP_BYTES = 2 * 1024 ** 3;

export interface OfflineMetaEntry {
  builtAt: string;
  records: number;
  packages: number;
  /** Size of the written index file in bytes. */
  bytes: number;
  etag?: string;
  lastModified?: string;
}
export type OfflineMeta = Partial<Record<Ecosystem, OfflineMetaEntry>>;

export const defaultOfflineDir = () => join(defaultCacheDir(), 'offline');

export interface UpdateOfflineOptions {
  ecosystems?: readonly Ecosystem[];
  dir?: string;
  fetch?: FetchFn;
  baseUrl?: string;
  maxBytes?: number;
  now?: () => Date;
  onProgress?: (message: string) => void;
}

export interface UpdateOfflineResult {
  dir: string;
  updated: Partial<Record<Ecosystem, OfflineMetaEntry>>;
  /** Ecosystems whose dump had not changed (HTTP 304). */
  unchanged: Ecosystem[];
}

const indexPath = (dir: string, eco: string) => join(dir, `${eco}.json`);

export async function readOfflineMeta(dir: string = defaultOfflineDir()): Promise<OfflineMeta> {
  try {
    return JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as OfflineMeta;
  } catch {
    return {};
  }
}

async function download(
  fetchFn: FetchFn,
  url: string,
  maxBytes: number,
  headers: Record<string, string>,
  onProgress?: (message: string) => void,
): Promise<{ data: Uint8Array; etag?: string; lastModified?: string } | 'not-modified'> {
  const res = await fetchFn(url, { headers });
  if (res.status === 304) return 'not-modified';
  if (!res.ok) throw new Error(`Download of ${url} failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`${url} is ${declared} bytes, over the size limit`);
  if (!res.body) throw new Error(`${url} returned no body`);

  const chunks: Uint8Array[] = [];
  let total = 0;
  let lastReport = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${url} exceeds the size limit of ${maxBytes} bytes`);
    }
    chunks.push(value);
    if (total - lastReport >= 8 * 1024 ** 2) {
      lastReport = total;
      onProgress?.(`downloaded ${(total / 1024 ** 2).toFixed(0)} MB`);
    }
  }
  const data = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    data.set(c, at);
    at += c.byteLength;
  }
  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  return {
    data,
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
  };
}

/**
 * Writes one package per line so the file stays valid JSON but can be read back
 * line by line (the npm index is too large for a single string).
 */
async function writeIndex(path: string, index: OfflineIndexBuilder, builtAt: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  const out = createWriteStream(tmp);
  const write = async (s: string) => {
    if (!out.write(s)) await once(out, 'drain');
  };
  await write(
    `{"ecosystem":${JSON.stringify(index.ecosystem)},"builtAt":${JSON.stringify(builtAt)},"packages":{\n`,
  );
  let first = true;
  for (const [name, records] of index.entries()) {
    await write(`${first ? '' : ','}${JSON.stringify(name)}:${JSON.stringify(records)}\n`);
    first = false;
  }
  await write('}}\n');
  out.end();
  await once(out, 'finish');
  await rename(tmp, path);
}

/**
 * Downloads the OSV dump of each ecosystem and writes a compact index.
 *
 * Memory: the npm dump is large (hundreds of MB zipped). The zip is held as one
 * buffer, but entries are inflated and parsed one at a time and only the indexed
 * (ecosystem-filtered) records are kept; the index is streamed to disk.
 */
export async function updateOfflineDatabase(
  options: UpdateOfflineOptions = {},
): Promise<UpdateOfflineResult> {
  const dir = options.dir ?? defaultOfflineDir();
  const fetchFn = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const base = options.baseUrl ?? OSV_DUMP_BASE;
  const maxBytes = options.maxBytes ?? MAX_DUMP_BYTES;
  const say = options.onProgress;
  await mkdir(dir, { recursive: true });

  const meta = await readOfflineMeta(dir);
  const result: UpdateOfflineResult = { dir, updated: {}, unchanged: [] };

  for (const eco of options.ecosystems ?? ECOSYSTEMS) {
    const previous = meta[eco];
    const headers: Record<string, string> = {};
    const hasFile = await stat(indexPath(dir, eco)).then(
      () => true,
      () => false,
    );
    if (previous?.etag && hasFile) headers['If-None-Match'] = previous.etag;

    say?.(`${eco}: downloading`);
    const got = await download(fetchFn, `${base}/${eco}/all.zip`, maxBytes, headers, (m) =>
      say?.(`${eco}: ${m}`),
    );
    if (got === 'not-modified') {
      result.unchanged.push(eco);
      say?.(`${eco}: up to date`);
      continue;
    }

    say?.(`${eco}: indexing`);
    const builder = new OfflineIndexBuilder(eco);
    for (const entry of readZip(got.data, inflateRawSync)) {
      if (!entry.name.endsWith('.json')) continue;
      builder.add(JSON.parse(Buffer.from(entry.read()).toString('utf8')) as OsvRecord);
    }
    const builtAt = (options.now?.() ?? new Date()).toISOString();
    const file = indexPath(dir, eco);
    await writeIndex(file, builder, builtAt);

    const entry: OfflineMetaEntry = {
      builtAt,
      records: builder.count,
      packages: [...builder.entries()].length,
      bytes: (await stat(file)).size,
      ...(got.etag ? { etag: got.etag } : {}),
      ...(got.lastModified ? { lastModified: got.lastModified } : {}),
    };
    meta[eco] = entry;
    result.updated[eco] = entry;
    // Persist after each ecosystem so an interrupted run keeps finished work.
    const tmp = join(dir, `meta.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, join(dir, 'meta.json'));
    say?.(`${eco}: ${entry.records} records`);
  }
  return result;
}

async function readIndex(path: string): Promise<OfflineIndex> {
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  let index: OfflineIndex | undefined;
  for await (const line of lines) {
    if (!index) {
      index = JSON.parse(`${line}}}`) as OfflineIndex;
      continue;
    }
    if (line === '}}' || line === '') continue;
    Object.assign(index.packages, JSON.parse(`{${line.replace(/^,/, '')}}`));
  }
  if (!index) throw new Error(`${path} is empty`);
  return index;
}

/**
 * Offline database that reads an ecosystem's index on its first query and
 * reports `offline-missing-ecosystem` once per queried ecosystem whose index is absent.
 */
export class LazyOfflineDatabase {
  private readonly loaded = new Map<Ecosystem, Promise<OfflineDatabase | undefined>>();
  private readonly missing: Ecosystem[] = [];

  constructor(
    private readonly dir: string,
    /** Build times from meta.json (see `readOfflineMeta`). */
    readonly builtAt: Record<string, string> = {},
  ) {}

  async query(ecosystem: string, name: string, version: string): Promise<OsvRecord[]> {
    if (!(ECOSYSTEMS as readonly string[]).includes(ecosystem)) return [];
    const eco = ecosystem as Ecosystem;
    let pending = this.loaded.get(eco);
    if (!pending) {
      pending = readIndex(indexPath(this.dir, eco)).then(
        (index) => new OfflineDatabase([index]),
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          this.missing.push(eco);
          return undefined;
        },
      );
      this.loaded.set(eco, pending);
    }
    return (await pending)?.query(ecosystem, name, version) ?? [];
  }

  warnings(): Warning[] {
    return this.missing.map((eco) => ({
      code: 'offline-missing-ecosystem',
      message: `No offline data for ${eco}; its packages were not checked. Run: vulnstack db update --ecosystem ${eco}`,
    }));
  }
}

/** Opens the offline database in `dir` without reading any index yet. */
export async function openOfflineDatabase(
  dir: string = defaultOfflineDir(),
): Promise<LazyOfflineDatabase> {
  const meta = await readOfflineMeta(dir);
  const builtAt = Object.fromEntries(
    Object.entries(meta).map(([eco, entry]) => [eco, entry.builtAt]),
  );
  return new LazyOfflineDatabase(dir, builtAt);
}

/** Loads the requested ecosystems (default: all); missing ones are reported, not thrown. */
export async function loadOfflineDatabase(
  dir: string = defaultOfflineDir(),
  ecosystems: readonly Ecosystem[] = ECOSYSTEMS,
): Promise<{ database: OfflineDatabase; missing: Ecosystem[] }> {
  const indexes: OfflineIndex[] = [];
  const missing: Ecosystem[] = [];
  for (const eco of ecosystems) {
    try {
      indexes.push(await readIndex(indexPath(dir, eco)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(eco);
    }
  }
  return { database: new OfflineDatabase(indexes), missing };
}

// ---------------------------------------------------------------------------
// CISA KEV + FIRST EPSS for offline scans
// ---------------------------------------------------------------------------

export const KEV_DUMP_URL =
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
export const EPSS_DUMP_URL = 'https://epss.empiricalsecurity.com/epss_scores-current.csv.gz';
/** KEV is ~1 MB and the EPSS csv.gz ~5 MB; these limits are generous, not tight. */
export const MAX_KEV_BYTES = 64 * 1024 ** 2;
export const MAX_EPSS_BYTES = 256 * 1024 ** 2;
/** Upper bound for the decompressed EPSS csv (guards against gzip bombs). */
export const MAX_EPSS_TEXT_BYTES = 1024 ** 3;

export interface ExploitMetaEntry {
  builtAt: string;
  records: number;
  bytes: number;
  etag?: string;
  lastModified?: string;
}
export interface ExploitMeta {
  kev?: ExploitMetaEntry;
  epss?: ExploitMetaEntry;
}

export interface UpdateExploitOptions {
  dir?: string;
  fetch?: FetchFn;
  kevUrl?: string;
  epssUrl?: string;
  maxKevBytes?: number;
  maxEpssBytes?: number;
  now?: () => Date;
  onProgress?: (message: string) => void;
}

export interface UpdateExploitResult {
  dir: string;
  updated: ExploitMeta;
  unchanged: ('kev' | 'epss')[];
}

const exploitMetaPath = (dir: string) => join(dir, 'exploit-meta.json');

export async function readExploitMeta(dir: string = defaultOfflineDir()): Promise<ExploitMeta> {
  try {
    return JSON.parse(await readFile(exploitMetaPath(dir), 'utf8')) as ExploitMeta;
  } catch {
    return {};
  }
}

async function writeAtomic(path: string, data: string | Uint8Array) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Decompresses and parses an EPSS csv.gz. */
export function parseEpssGzip(data: Uint8Array): Map<string, EpssEntry> {
  const text = gunzipSync(data, { maxOutputLength: MAX_EPSS_TEXT_BYTES }).toString('utf8');
  return parseEpssCsv(text);
}

/** Downloads KEV (`kev.json`) and EPSS (`epss.csv.gz`) into the offline directory. */
export async function updateExploitData(
  options: UpdateExploitOptions = {},
): Promise<UpdateExploitResult> {
  const dir = options.dir ?? defaultOfflineDir();
  const fetchFn = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const say = options.onProgress;
  await mkdir(dir, { recursive: true });
  const meta = await readExploitMeta(dir);
  const result: UpdateExploitResult = { dir, updated: {}, unchanged: [] };

  const sets = [
    {
      name: 'kev' as const,
      file: 'kev.json',
      url: options.kevUrl ?? KEV_DUMP_URL,
      max: options.maxKevBytes ?? MAX_KEV_BYTES,
      count: (data: Uint8Array) => parseKev(JSON.parse(Buffer.from(data).toString('utf8'))).size,
    },
    {
      name: 'epss' as const,
      file: 'epss.csv.gz',
      url: options.epssUrl ?? EPSS_DUMP_URL,
      max: options.maxEpssBytes ?? MAX_EPSS_BYTES,
      count: (data: Uint8Array) => parseEpssGzip(data).size,
    },
  ];
  for (const set of sets) {
    const previous = meta[set.name];
    const hasFile = await stat(join(dir, set.file)).then(
      () => true,
      () => false,
    );
    const headers: Record<string, string> = {};
    if (previous?.etag && hasFile) headers['If-None-Match'] = previous.etag;
    say?.(`${set.name}: downloading`);
    const urls = set.name === 'kev' && !options.kevUrl ? [set.url, KEV_MIRROR_URL] : [set.url];
    let got: Awaited<ReturnType<typeof download>> | undefined;
    let lastError: unknown;
    for (const url of urls) {
      try {
        got = await download(fetchFn, url, set.max, headers, (m) => say?.(`${set.name}: ${m}`));
        break;
      } catch (e) {
        lastError = e;
        say?.(`${set.name}: ${url} failed, trying next source`);
      }
    }
    if (!got) throw lastError;
    if (got === 'not-modified') {
      result.unchanged.push(set.name);
      say?.(`${set.name}: up to date`);
      continue;
    }
    // Validate before replacing the previous good file.
    const records = set.count(got.data);
    if (records === 0) throw new Error(`${set.url} contained no records`);
    await writeAtomic(join(dir, set.file), got.data);
    const entry: ExploitMetaEntry = {
      builtAt: (options.now?.() ?? new Date()).toISOString(),
      records,
      bytes: got.data.byteLength,
      ...(got.etag ? { etag: got.etag } : {}),
      ...(got.lastModified ? { lastModified: got.lastModified } : {}),
    };
    meta[set.name] = entry;
    result.updated[set.name] = entry;
    await writeAtomic(exploitMetaPath(dir), JSON.stringify(meta, null, 2));
    say?.(`${set.name}: ${records} records`);
  }
  return result;
}

/** Reads KEV / EPSS from the offline directory; a missing file becomes a warning, not an error. */
export async function loadExploitData(
  dir: string = defaultOfflineDir(),
): Promise<ExploitSource & { warnings: Warning[]; builtAt: Record<string, string> }> {
  const warnings: Warning[] = [];
  const builtAt: Record<string, string> = {};
  const meta = await readExploitMeta(dir);
  const missing = (what: string) =>
    warnings.push({
      code: 'offline-missing-exploit-data',
      message: `No offline ${what} data; run "vulnstack db update" to fetch it.`,
    });

  let kev = new Map<string, KevEntry>();
  try {
    kev = parseKev(JSON.parse(await readFile(join(dir, 'kev.json'), 'utf8')));
    if (meta.kev) builtAt.kev = meta.kev.builtAt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    missing('CISA KEV');
  }
  let epss = new Map<string, EpssEntry>();
  try {
    epss = parseEpssGzip(await readFile(join(dir, 'epss.csv.gz')));
    if (meta.epss) builtAt.epss = meta.epss.builtAt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    missing('EPSS');
  }
  return { kev, epss, warnings, builtAt };
}
