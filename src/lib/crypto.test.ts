import { expect, test } from 'bun:test';
import {
  checkPassword,
  fromBase64,
  fromPassword,
  linkKey,
  openName,
  openRootKey,
  openShare,
  openShareKey,
  openText,
  openTheme,
  padId,
  padKeys,
  random,
  sealName,
  sealRootKey,
  sealShare,
  sealShareKey,
  sealText,
  sealTheme,
  toBase64
} from './crypto.ts';
import { ARGON2 } from './limits.ts';
import { padded } from './padme.ts';

test('base64url round-trips without padding', () => {
  const bytes = random(31);
  const text = toBase64(bytes);
  expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(fromBase64(text)).toEqual(bytes);
});

test('passwords are counted in characters', () => {
  expect(checkPassword('1234567')).not.toBeNull();
  expect(checkPassword('12345678')).toBeNull();
  expect(checkPassword('ééééééé')).not.toBeNull();
});

test('the root key opens only with its password, for its root', async () => {
  const salt = random(16);
  const rootKey = random(32);
  const { wrap, auth } = await fromPassword('correct horse', salt, ARGON2);
  const sealed = await sealRootKey(wrap, rootKey, 'a');
  expect(await openRootKey(wrap, sealed, 'a')).toEqual(rootKey);
  expect(await openRootKey(wrap, sealed, 'b')).toBeNull();
  const wrong = await fromPassword('wrong horse', salt, ARGON2);
  expect(await openRootKey(wrong.wrap, sealed, 'a')).toBeNull();
  expect(wrong.auth).not.toEqual(auth);
});

test("a root's own Argon2 cost derives its keys; one outside pad's bounds is refused", async () => {
  const salt = random(16);
  const stronger = { ...ARGON2, iterations: ARGON2.iterations + 1 };
  const a = await fromPassword('correct horse', salt, ARGON2);
  const b = await fromPassword('correct horse', salt, stronger);
  expect(b.auth).not.toEqual(a.auth);
  // A server serving a cheaper cost would get an auth it can guess from cheaply.
  for (const cost of [
    { ...ARGON2, memory: ARGON2.memory / 2 },
    { ...ARGON2, iterations: 1 },
    { ...ARGON2, memory: 1024 * 1024 }
  ])
    await expect(fromPassword('correct horse', salt, cost)).rejects.toThrow('refuses');
});

test('text and names open only under the id they were sealed for', async () => {
  const keys = await padKeys(random(32));
  const id = await padId(keys, 'a/b');
  expect(await padId(keys, 'a/b')).toBe(id);
  const other = await padId(keys, 'a/c');
  expect(other).not.toBe(id);

  const text = await sealText(keys, id, 'hello');
  expect(await openText(keys, id, text)).toBe('hello');
  await expect(openText(keys, other, text)).rejects.toThrow();

  const name = await sealName(keys, id, 'a/b');
  expect(await openName(keys, id, name)).toEqual({ path: 'a/b', padded: true });
  await expect(openName(keys, other, name)).rejects.toThrow();
});

test("a link's pads open with its key, for its id, and its key with the root's", async () => {
  const keys = await padKeys(random(32));
  const key = random(32);
  const plain = new TextEncoder().encode('{"path":"a","pads":[]}');
  const sealed = await sealShare(key, 'link', plain);
  expect(await openShare(key, 'link', sealed)).toEqual(plain);
  await expect(openShare(random(32), 'link', sealed)).rejects.toThrow();
  await expect(openShare(key, 'other', sealed)).rejects.toThrow();
  for (const password of [false, true])
    expect(
      await openShareKey(keys, 'link', await sealShareKey(keys, 'link', key, password))
    ).toEqual({ key, password });

  // A key sealed before links had passwords: the key alone.
  const iv = random(12);
  const old = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('pad share key\nlink') },
      keys.content,
      key
    )
  );
  expect(await openShareKey(keys, 'link', new Uint8Array([...iv, ...old]))).toEqual({
    key,
    password: false
  });
});

test('a link with a password opens with both its key and the password, and only for its id', async () => {
  const key = random(32);
  const plain = new TextEncoder().encode('{"path":"a","pads":[]}');
  const sealed = await sealShare(await linkKey(key, 'correct horse', 'link'), 'link', plain);
  expect(await openShare(await linkKey(key, 'correct horse', 'link'), 'link', sealed)).toEqual(
    plain
  );
  await expect(openShare(key, 'link', sealed)).rejects.toThrow();
  await expect(
    openShare(await linkKey(key, 'correct hors', 'link'), 'link', sealed)
  ).rejects.toThrow();
  await expect(
    openShare(await linkKey(random(32), 'correct horse', 'link'), 'link', sealed)
  ).rejects.toThrow();
  // The id salts the password: the same password and key give another link's key elsewhere.
  expect(await linkKey(key, 'correct horse', 'other')).not.toEqual(
    await linkKey(key, 'correct horse', 'link')
  );
});

test("a theme opens only with its root's keys, and isn't a pad's text", async () => {
  const keys = await padKeys(random(32));
  const sealed = await sealTheme(keys, '{"bg":"#000000"}');
  expect(await openTheme(keys, sealed)).toBe('{"bg":"#000000"}');
  await expect(openTheme(await padKeys(random(32)), sealed)).rejects.toThrow();
  const id = await padId(keys, 'a');
  await expect(openText(keys, id, sealed)).rejects.toThrow();
});

test('text and names are padded, to the same size when short', async () => {
  const keys = await padKeys(random(32));
  const id = await padId(keys, 'a');
  // 28: the nonce and the tag.
  expect((await sealText(keys, id, 'a')).length).toBe(256 + 28);
  expect((await sealText(keys, id, 'a'.repeat(255))).length).toBe(256 + 28);
  expect((await sealText(keys, id, 'a'.repeat(256))).length).toBe(padded(257) + 28);
  expect(await openText(keys, id, await sealText(keys, id, 'a\0'))).toBe('a\0');
  // Text can end in the marker's byte: U+00C0 is C3 80 in UTF-8.
  expect(await openText(keys, id, await sealText(keys, id, 'À'))).toBe('À');
  expect(await openText(keys, id, await sealText(keys, id, ''))).toBe('');
  expect(fromBase64(await sealName(keys, id, 'a')).length).toBe(128 + 28);
  expect(fromBase64(await sealName(keys, id, 'x'.repeat(127))).length).toBe(128 + 28);
});

test('text and names sealed before padding still open', async () => {
  const keys = await padKeys(random(32));
  const id = await padId(keys, 'a');
  const old = async (aad: string, text: string) => {
    const iv = random(12);
    const additionalData = new TextEncoder().encode(aad);
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData },
      keys.content,
      new TextEncoder().encode(text)
    );
    return new Uint8Array([...iv, ...new Uint8Array(sealed)]);
  };
  expect(await openText(keys, id, await old(`pad text\n${id}`, 'hiÀ'))).toBe('hiÀ');
  const name = toBase64(await old(`pad name\n${id}`, 'a'));
  expect(await openName(keys, id, name)).toEqual({ path: 'a', padded: false });
  await expect(openText(keys, id, await old(`pad text\nother`, 'hi'))).rejects.toThrow();
});
