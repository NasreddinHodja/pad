import { readFile } from 'node:fs/promises';
import {
  claim,
  claimNew,
  editor,
  expect,
  expectAccessible,
  freshRoot,
  opened,
  status,
  test,
  unlock
} from './fixtures.ts';
import { unzip } from './unzip.ts';

test('claim, reload, unlock in another browser, lock', async ({ page, newContext }) => {
  const root = freshRoot();
  await page.goto('/');
  await expectAccessible(page, 'home');
  await page.getByRole('textbox', { name: 'pad path' }).fill(root);
  await page.getByRole('button', { name: 'open', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: `/${root} is free` })).toBeVisible();
  await expectAccessible(page, 'gate, claiming');
  await claim(page, root);
  await expectAccessible(page, 'pad');

  await editor(page).fill('hello');
  await expect(status(page)).toHaveText('saved');
  await page.reload();
  await opened(page);
  await expect(editor(page)).toHaveValue('hello');

  // Another browser has neither the cookie nor the keys: the password gives both.
  const other = await (await newContext()).newPage();
  await other.goto('/' + root);
  await expect(other.getByRole('heading', { level: 1, name: `/${root} is locked` })).toBeVisible();
  await expectAccessible(other, 'gate, unlocking');
  await unlock(other, root);
  await expect(editor(other)).toHaveValue('hello');

  // Locking signs this browser out; the other stays in.
  await page.getByRole('button', { name: 'lock', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page.goto('/' + root);
  await expect(page.getByRole('heading', { level: 1, name: `/${root} is locked` })).toBeVisible();
  await other.reload();
  await opened(other);
  await expect(editor(other)).toHaveValue('hello');
});

test.describe('a root with a pad under it', () => {
  // The share dialog copies the new link.
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('finder, read-only link, export', async ({ page, newContext }) => {
    const root = await claimNew(page);
    await editor(page).fill('top');
    await expect(status(page)).toHaveText('saved');

    // A pad under it, made from the finder.
    const finder = page.getByRole('combobox', { name: `find or make a pad under ${root}` });
    await finder.click();
    await finder.fill('sub');
    await finder.press('Enter');
    await expect(page).toHaveURL(`/${root}/sub`);
    await opened(page);
    await editor(page).fill('below');
    await expect(status(page)).toHaveText('saved');
    await page.getByRole('navigation', { name: 'path' }).getByRole('link', { name: root }).click();
    await expect(page).toHaveURL(`/${root}`);
    await opened(page);
    await expect(editor(page)).toHaveValue('top');

    await finder.click();
    await expect(page.getByRole('option', { name: /sub/ })).toBeVisible();
    await expectAccessible(page, 'finder, open');
    await finder.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();

    // A read-only link to the root and the pad under it.
    await page.getByRole('button', { name: 'share', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'read-only links' });
    await expect(dialog.getByText('no links yet.')).toBeVisible();
    await dialog.getByRole('button', { name: 'new link', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'copied', exact: true })).toBeVisible();
    await expectAccessible(page, 'share dialog');
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toMatch(new RegExp(`/_/${root}/s/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$`));
    await dialog.getByRole('button', { name: 'close', exact: true }).click();
    await expect(dialog).toBeHidden();

    // Opened by a browser with no password: the copy, read-only.
    const reader = await (await newContext()).newPage();
    await reader.goto(url);
    await expect(reader.getByText(/^read-only, as of /)).toBeVisible();
    await expect(reader.locator('pre')).toHaveText('top');
    await expect(reader.getByRole('textbox')).toHaveCount(0);
    await expectAccessible(reader, 'read-only link');
    await reader
      .getByRole('navigation', { name: `pads under /${root}` })
      .getByRole('link')
      .click();
    await expect(reader.locator('pre')).toHaveText('below');

    // Export: a zip of org files, the root's and the one under it.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'export', exact: true }).click()
    ]);
    expect(download.suggestedFilename()).toBe(`${root}.zip`);
    const files = unzip(await readFile(await download.path()));
    expect(Object.fromEntries(files)).toEqual({
      [`${root}.org`]: 'top',
      [`${root}/sub.org`]: 'below'
    });
    await expect(status(page)).toHaveText('exported');
  });
});
