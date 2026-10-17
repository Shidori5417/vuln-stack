/** Minimal ZIP reader (stored + deflate, ZIP64 aware) working on an in-memory buffer. */

export type InflateRaw = (data: Uint8Array) => Uint8Array;

export interface ZipEntry {
  name: string;
  /** Decompressed bytes. Called lazily so skipped entries cost nothing. */
  read(): Uint8Array;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

export class ZipError extends Error {
  constructor(message: string) {
    super(`Invalid ZIP: ${message}`);
    this.name = 'ZipError';
  }
}

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - MAX16);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  throw new ZipError('end of central directory not found');
}

const u64 = (view: DataView, offset: number): number => {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('offset too large');
  return Number(value);
};

function check(view: DataView, offset: number, length: number): void {
  if (offset < 0 || offset + length > view.byteLength) throw new ZipError('truncated data');
}

/** Iterates the central directory; directories are skipped. */
export function* readZip(data: Uint8Array, inflateRaw: InflateRaw): Generator<ZipEntry> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEocd(view);
  let count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  if (count === MAX16 || cdOffset === MAX32 || eocd >= 20) {
    const loc = eocd - 20;
    if (loc >= 0 && view.getUint32(loc, true) === SIG_LOC64) {
      const rec = u64(view, loc + 8);
      check(view, rec, 56);
      if (view.getUint32(rec, true) !== SIG_EOCD64) throw new ZipError('bad ZIP64 record');
      count = u64(view, rec + 32);
      cdOffset = u64(view, rec + 48);
    } else if (count === MAX16 || cdOffset === MAX32) {
      throw new ZipError('missing ZIP64 locator');
    }
  }

  const decoder = new TextDecoder();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    check(view, p, 46);
    if (view.getUint32(p, true) !== SIG_CEN) throw new ZipError('bad central directory entry');
    const method = view.getUint16(p + 10, true);
    let compSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    let local = view.getUint32(p + 42, true);
    check(view, p + 46, nameLen + extraLen);
    const name = decoder.decode(data.subarray(p + 46, p + 46 + nameLen));

    // ZIP64 extra field (id 1): only the fields whose 32-bit value is 0xFFFFFFFF, in this order.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = view.getUint16(x, true);
      const len = view.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (size === MAX32) {
          size = u64(view, q);
          q += 8;
        }
        if (compSize === MAX32) {
          compSize = u64(view, q);
          q += 8;
        }
        if (local === MAX32) local = u64(view, q);
        break;
      }
      x += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    const entryLocal = local;
    const entryComp = compSize;
    const entrySize = size;
    yield {
      name,
      read() {
        check(view, entryLocal, 30);
        if (view.getUint32(entryLocal, true) !== SIG_LOCAL) throw new ZipError('bad local header');
        const start =
          entryLocal +
          30 +
          view.getUint16(entryLocal + 26, true) +
          view.getUint16(entryLocal + 28, true);
        check(view, start, entryComp);
        const raw = data.subarray(start, start + entryComp);
        if (method === 0) return raw;
        if (method !== 8) throw new ZipError(`unsupported compression method ${method}`);
        const out = inflateRaw(raw);
        if (out.byteLength !== entrySize) throw new ZipError(`size mismatch for ${name}`);
        return out;
      },
    };
  }
}
