import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { crc32, ZipWriter } from './zip.ts';

const utf8 = new TextEncoder();

test('crc32 is the standard one', () => {
  expect(crc32(utf8.encode('123456789'))).toBe(0xcbf43926);
});

test('unzip reads back the files, deflated or stored, with a UTF-8 name among them', async () => {
  const files = [
    { name: 'notes.org', data: utf8.encode('* hello\n'.repeat(100)) },
    { name: 'notes/ação.org', data: utf8.encode('x') },
    { name: 'notes/empty.org', data: new Uint8Array() }
  ];
  const path = `${tmpdir()}/pad-zip-test-${Date.now()}.zip`;
  const out = new ZipWriter();
  for (const f of files) await out.add(f);
  await Bun.write(path, out.finish());
  const test = Bun.spawnSync(['unzip', '-t', path]);
  expect(test.exitCode).toBe(0);
  // Info-ZIP's unzip won't match a UTF-8 name it lists, so those read back by test only.
  for (const f of files.filter((f) => /^[\x20-\x7e]+$/.test(f.name))) {
    const out = Bun.spawnSync(['unzip', '-p', path, f.name]);
    expect(new Uint8Array(out.stdout)).toEqual(f.data);
  }
  rmSync(path);
});
