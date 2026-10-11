// A pad and every pad under it, as a zip of org files: `notes` gives
// notes.org, notes/today.org, notes/today/later.org. Built in the browser,
// since only it can read them.

import * as api from './api';
import type { Keys } from './crypto';
import { zip } from './zip';

/** Pads fetched at once: enough to hide the round trips, few enough for the server. */
const PARALLEL = 4;

const utf8 = new TextEncoder();

export type Pad = { path: string; text: string };

/**
 * The pad and every pad under it, by path. No cap of its own: a root holds
 * at most 16 MiB (ROOT_BYTES), which a browser zips in memory.
 */
export async function collect(
  root: string,
  keys: Keys,
  path: string,
  progress: (done: number, total: number) => void
) {
  const paths = (await api.list(root, keys)).filter((p) => p === path || p.startsWith(path + '/'));

  const out: Pad[] = [];
  let next = 0;
  progress(0, paths.length);
  async function worker() {
    while (next < paths.length) {
      const p = paths[next++];
      out.push({ path: p, text: await api.load(root, keys, p) });
      progress(out.length, paths.length);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function exportPads(
  root: string,
  keys: Keys,
  path: string,
  progress: (done: number, total: number) => void
) {
  const pads = await collect(root, keys, path, progress);
  if (!pads.length) throw new Error('nothing to export: the pad is empty');
  const base = path.split('/').at(-1)!;
  return zip(
    pads.map((p) => ({
      name: base + p.path.slice(path.length) + '.org',
      data: utf8.encode(p.text)
    }))
  );
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
