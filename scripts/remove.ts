// Takes down a root or a read-only link at once, for an abuse report: no
// grace, nothing to reclaim. A root goes with its pads, links, unlocks and
// devices, and its name is free to claim again; a link goes alone. Run beside
// the server: it reads every row from the database, so the next request sees
// the removal.
//
//   bun scripts/remove.ts data/pad.db root <name, or a pad's address>
//   bun scripts/remove.ts data/pad.db link <the link's address, or its id>
//
// In the image: docker exec pad bun /app/remove.js /data/pad.db … (install.org,
// Abuse).
import { Database } from 'bun:sqlite';
import { normalizePath } from '../src/lib/limits.ts';

const [file, kind, target] = process.argv.slice(2);
if (!file || !['root', 'link'].includes(kind) || !target) {
  console.error('usage: bun remove.ts <pad.db> root <name or address> | link <address or id>');
  process.exit(2);
}

/** The path of an address, decoded as the server decodes it; anything else as it is. */
function pathOf(text: string) {
  try {
    const url = new URL(text);
    return url.pathname.split('/').map(decodeURIComponent).join('/');
  } catch {
    return text;
  }
}

const db = new Database(file, { strict: true });
db.run('PRAGMA busy_timeout = 5000');
// As the server's own connection (db.ts): what's deleted leaves the file, and
// a root's rows go with it.
db.run('PRAGMA secure_delete = ON');
db.run('PRAGMA journal_size_limit = 0');
db.run('PRAGMA foreign_keys = ON');

if (kind === 'root') {
  // A pad's address names its root first; the rest is the pad's own path.
  const root = normalizePath(pathOf(target))?.split('/')[0];
  if (!root) {
    console.error(`not a root: ${target}`);
    process.exit(2);
  }
  const counts = db
    .query<{ pads: number; links: number }, [string]>(
      `SELECT (SELECT count(*) FROM sealed WHERE root = ?1) AS pads,
         (SELECT count(*) FROM shares WHERE root = ?1) AS links
       FROM roots WHERE name = ?1`
    )
    .get(root);
  if (!counts) {
    console.error(`no root /${root}`);
    process.exit(1);
  }
  db.query('DELETE FROM roots WHERE name = ?').run(root);
  console.log(`removed /${root}: ${counts.pads} pads, ${counts.links} links`);
} else {
  // The id is the link's last segment; its key, after the #, isn't needed.
  const id = pathOf(target).split('/').pop()!;
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) {
    console.error(`not a link: ${target}`);
    process.exit(2);
  }
  const row = db
    .query<{ root: string }, [string]>('DELETE FROM shares WHERE id = ? RETURNING root')
    .get(id);
  if (!row) {
    console.error(`no link ${id}`);
    process.exit(1);
  }
  console.log(`removed link ${id} of /${row.root}`);
}
db.close();
