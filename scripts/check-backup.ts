// Opens every pad of one root in a copy of the database, with the browser's
// own code (src/lib/crypto.ts): proof that a backup restores to something
// readable, not just to a file SQLite accepts. Keep a root for this whose
// password isn't any you use, with a few pads in it.
//
//   bun scripts/check-backup.ts backups/pad-….db <root>
//
// The password is read from standard input. Run it from the repo, on a
// machine that isn't the server: the drill is the copy getting there too.
import { Database } from 'bun:sqlite';
import {
  fromPassword,
  openName,
  openRootKey,
  openText,
  openTheme,
  padKeys
} from '../src/lib/crypto.ts';

const [file, root] = process.argv.slice(2);
if (!file || !root) {
  console.error('usage: bun scripts/check-backup.ts <copy.db> <root>   (password on stdin)');
  process.exit(2);
}

const db = new Database(file, { readonly: true });
type Root = { salt: Uint8Array; sealed_key: Uint8Array; theme: Uint8Array | null };
const row = db
  .query<Root, [string]>('SELECT salt, sealed_key, theme FROM roots WHERE name = ?')
  .get(root);
if (!row) {
  console.error(`no root ${root} in ${file}`);
  process.exit(1);
}

process.stderr.write('password: ');
let password = '';
for await (const line of console) {
  password = line;
  break;
}

const { wrap } = await fromPassword(password, row.salt);
const rootKey = await openRootKey(wrap, row.sealed_key, root);
if (!rootKey) {
  console.error('wrong password, or the root key was changed');
  process.exit(1);
}
const keys = await padKeys(rootKey);

const pads = db
  .query<{ id: string; name: string; data: Uint8Array }, [string]>(
    'SELECT id, name, data FROM sealed WHERE root = ? AND deleted_at IS NULL'
  )
  .all(root);
let failed = 0;
for (const pad of pads) {
  try {
    await openName(keys, pad.id, pad.name);
    await openText(keys, pad.id, pad.data);
  } catch {
    failed++;
    console.error(`pad ${pad.id} doesn't open`);
  }
}
const theme =
  row.theme &&
  (await openTheme(keys, row.theme).then(
    () => true,
    () => false
  ));
if (theme === false) console.error("the theme doesn't open");

console.log(`${pads.length - failed} of ${pads.length} pads open${theme ? ', and the theme' : ''}`);
process.exit(failed || theme === false ? 1 : 0);
