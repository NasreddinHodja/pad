// The browser's own deflate, raw, as zip and the read-only links use it.

export async function deflate(data: Uint8Array<ArrayBuffer>) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Refused past `max` bytes, before they're all in memory: deflate has no size
 * to check first, and 1 MiB of it can inflate to 1 GiB (1029:1, measured).
 */
export async function inflate(data: Uint8Array<ArrayBuffer>, max: number) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > max) throw new Error(`malformed: inflates past ${max} bytes`);
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
