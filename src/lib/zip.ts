// A zip of text files, written in the browser: the server can't, since it
// can't read the pads. Deflated by the browser's own CompressionStream. No
// zip64, so under 65535 files and 4 GiB, which an export keeps well under.

import { deflate } from './deflate.ts';

export type File = { name: string; data: Uint8Array };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS time and date, as zip has them. */
function dosTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

const utf8 = new TextEncoder();

/**
 * A zip built a file at a time: each is compressed as it's added and only
 * its compressed bytes are kept, so its text can go before the next comes.
 */
export class ZipWriter {
  #parts: BlobPart[] = [];
  #central: Uint8Array<ArrayBuffer>[] = [];
  #offset = 0;
  #count = 0;
  #time: number;
  #date: number;

  constructor(now = new Date()) {
    ({ time: this.#time, date: this.#date } = dosTime(now));
  }

  async add(file: File) {
    const [time, date] = [this.#time, this.#date];
    const name = utf8.encode(file.name);
    const crc = crc32(file.data);
    const deflated = await deflate(new Uint8Array(file.data));
    // Stored when deflating doesn't help.
    const [method, body] =
      deflated.length < file.data.length ? [8, deflated] : [0, new Uint8Array(file.data)];

    const head = (signature: number, size: number) => {
      const bytes = new Uint8Array(size + name.length);
      const v = new DataView(bytes.buffer);
      v.setUint32(0, signature, true);
      return { bytes, v };
    };
    // Bit 11: the name is UTF-8.
    const fields = (v: DataView, at: number) => {
      v.setUint16(at, 20, true);
      v.setUint16(at + 2, 0x0800, true);
      v.setUint16(at + 4, method, true);
      v.setUint16(at + 6, time, true);
      v.setUint16(at + 8, date, true);
      v.setUint32(at + 10, crc, true);
      v.setUint32(at + 14, body.length, true);
      v.setUint32(at + 18, file.data.length, true);
      v.setUint16(at + 22, name.length, true);
    };

    const local = head(0x04034b50, 30);
    fields(local.v, 4);
    local.bytes.set(name, 30);
    this.#parts.push(local.bytes, body);

    const entry = head(0x02014b50, 46);
    entry.v.setUint16(4, 20, true);
    fields(entry.v, 6);
    entry.v.setUint32(42, this.#offset, true);
    entry.bytes.set(name, 46);
    this.#central.push(entry.bytes);

    this.#offset += local.bytes.length + body.length;
    this.#count++;
  }

  finish() {
    const size = this.#central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, this.#count, true);
    v.setUint16(10, this.#count, true);
    v.setUint32(12, size, true);
    v.setUint32(16, this.#offset, true);
    return new Blob([...this.#parts, ...this.#central, end], { type: 'application/zip' });
  }
}

export async function zip(files: File[], now = new Date()) {
  const out = new ZipWriter(now);
  for (const file of files) await out.add(file);
  return out.finish();
}
