import { deflateRawSync } from 'node:zlib';

export interface ZipFile {
  name: string;
  data: string | Uint8Array;
  /** store (method 0) instead of deflate */
  stored?: boolean;
}

/** Tiny ZIP writer for tests. `zip64` emits ZIP64 extra fields, EOCD record and locator. */
export function makeZip(files: ZipFile[], options: { zip64?: boolean } = {}): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const z64 = options.zip64 === true;

  for (const f of files) {
    const raw = Buffer.from(typeof f.data === 'string' ? f.data : f.data);
    const method = f.stored ? 0 : 8;
    const body = f.stored ? raw : deflateRawSync(raw);
    const name = Buffer.from(f.name);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const extra = Buffer.alloc(z64 ? 28 : 0);
    if (z64) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(45, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(z64 ? 0xffffffff : body.length, 20);
    cen.writeUInt32LE(z64 ? 0xffffffff : raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(extra.length, 30);
    cen.writeUInt32LE(z64 ? 0xffffffff : offset, 42);
    central.push(cen, name, extra);
    offset += 30 + name.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(z64 ? 0xffff : files.length, 8);
  eocd.writeUInt16LE(z64 ? 0xffff : files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(z64 ? 0xffffffff : offset, 16);
  const tail: Buffer[] = [];
  if (z64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeBigUInt64LE(BigInt(files.length), 24);
    rec.writeBigUInt64LE(BigInt(files.length), 32);
    rec.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    rec.writeBigUInt64LE(BigInt(offset + cdBuf.length - cdBuf.length), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cdBuf.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  return new Uint8Array(Buffer.concat([...parts, cdBuf, ...tail, eocd]));
}
