// A pad and every pad under it, as a zip of org files: `notes` gives
// notes.org, notes/today.org, notes/today/later.org. Built in the browser,
// since only it can read them.

import * as api from './api.ts';
import type { Keys } from './crypto.ts';
import { BATCH_PADS } from './limits.ts';
import { ZipWriter } from './zip.ts';

const utf8Decode = new TextDecoder();

export type Pad = { path: string; text: string };

/** The pad and every pad under it, by path, sorted. */
async function under(root: string, keys: Keys, path: string) {
  return (await api.list(root, keys))
    .filter((p) => p === path || p.startsWith(path + '/'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * `paths` a batch at a time (BATCH_PADS a request), the next asked for while
 * `each` handles the current one.
 */
async function inBatches(
  root: string,
  keys: Keys,
  paths: string[],
  each: (batch: { path: string; bytes: Uint8Array<ArrayBuffer> }[]) => Promise<void>
) {
  const fetch = (from: number) => {
    const batch = paths.slice(from, from + BATCH_PADS);
    return api
      .loadMany(root, keys, batch)
      .then((texts) => batch.map((p, i) => ({ path: p, bytes: texts[i] })));
  };
  let next = paths.length ? fetch(0) : null;
  for (let from = 0; next; from += BATCH_PADS) {
    const batch = await next;
    next = from + BATCH_PADS < paths.length ? fetch(from + BATCH_PADS) : null;
    await each(batch);
  }
}

/**
 * The pad and every pad under it, all at once: a read-only link's copy is
 * one sealed blob. At most a root's 16 MiB (ROOT_BYTES).
 */
export async function collect(
  root: string,
  keys: Keys,
  path: string,
  progress: (done: number, total: number) => void
) {
  const paths = await under(root, keys, path);
  const out: Pad[] = [];
  progress(0, paths.length);
  await inBatches(root, keys, paths, async (batch) => {
    for (const p of batch) out.push({ path: p.path, text: utf8Decode.decode(p.bytes) });
    progress(out.length, paths.length);
  });
  return out;
}

/**
 * The pad and every pad under it as a zip, built a batch at a time: each
 * pad's text is compressed into the zip and let go before the next batch.
 */
export async function exportPads(
  root: string,
  keys: Keys,
  path: string,
  progress: (done: number, total: number) => void
) {
  const paths = await under(root, keys, path);
  if (!paths.length) throw new Error('nothing to export: the pad is empty');
  const base = path.split('/').at(-1)!;
  const out = new ZipWriter();
  let done = 0;
  progress(0, paths.length);
  await inBatches(root, keys, paths, async (batch) => {
    for (const p of batch) {
      await out.add({ name: base + p.path.slice(path.length) + '.org', data: p.bytes });
      progress(++done, paths.length);
    }
  });
  return out.finish();
}

/** Hands the browser a file to save. */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
