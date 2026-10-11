// A root's theme, which its pads all take: three colours, sealed by the
// browser like a pad's text, so the server can't tell which. On the root's
// row, so a purge takes it too.

import { db } from './db.ts';

const getStmt = db.query<{ theme: Uint8Array | null }, [string]>(
  'SELECT theme FROM roots WHERE name = ?'
);
const setStmt = db.query('UPDATE roots SET theme = ? WHERE name = ?');

export function getTheme(root: string) {
  return getStmt.get(root)?.theme ?? null;
}

export function setTheme(root: string, sealed: Uint8Array) {
  setStmt.run(sealed, root);
}
