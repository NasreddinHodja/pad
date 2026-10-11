import { crc32, inflateRawSync } from 'node:zlib';

/**
 * A zip's files by name, read from its central directory, as src/lib/zip.ts
 * writes them: no comment, no zip64, stored or deflated. Throws on a CRC
 * that doesn't match.
 */
export function unzip(zip: Buffer) {
  const end = zip.length - 22;
  if (zip.readUInt32LE(end) !== 0x06054b50) throw new Error('no end of central directory');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`no central entry ${i}`);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);

    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : body;
    if (crc32(data) !== crc) throw new Error(`${name}: CRC doesn't match`);
    files.set(name, data.toString('utf8'));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}
