import { readFile } from 'node:fs/promises';
import {
  claim,
  claimNew,
  editor,
  expect,
  expectAccessible,
  freshRoot,
  opened,
  padUrl,
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
  await expect(other.getByLabel('password')).toBeFocused();
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

test("the about page, from the home page, with this server's limits", async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'how it works' }).click();
  await expect(page).toHaveURL('/_/about');
  await expect(page.getByText('here a pad holds 512 KiB')).toBeVisible();
  await expectAccessible(page, 'about');
  await page.getByRole('link', { name: '← pad' }).click();
  await expect(page).toHaveURL('/');
});

test.describe('a root with a pad under it', () => {
  // The share dialog copies the new link.
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('finder, read-only link, export', async ({ page, newContext }) => {
    // Every URL this browser asks for: the pad under the root must be in none.
    const asked: string[] = [];
    page.on('request', (r) => asked.push(r.url()));
    const root = await claimNew(page);
    await editor(page).fill('top');
    await expect(status(page)).toHaveText('saved');

    // A pad under it, made from the finder.
    const finder = page.getByRole('combobox', { name: `find or make a pad under ${root}` });
    await finder.click();
    await finder.fill('sub');
    await finder.press('Enter');
    await expect(page).toHaveURL(`/${root}#sub`);
    await opened(page);
    await editor(page).fill('below');
    await expect(status(page)).toHaveText('saved');
    await page.getByRole('navigation', { name: 'path' }).getByRole('link', { name: root }).click();
    await expect(page).toHaveURL(`/${root}`);
    await opened(page);
    await expect(editor(page)).toHaveValue('top');

    await finder.click();
    await expect(page.getByRole('option', { name: /sub/ })).toBeVisible();
    expect(asked.filter((u) => !u.includes('/_app/') && /sub/.test(u.replace(root, '')))).toEqual(
      []
    );
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
    expect(reader.url()).toBe(url + '~sub');
    // A link from before the place in it moved after the #: /s/<id>/sub#<key>.
    const [before, key] = url.split('#');
    await reader.goto(`${before}/sub#${key}`);
    await expect(reader).toHaveURL(url + '~sub');
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
    expect(asked.filter((u) => !u.includes('/_app/') && /sub/.test(u.replace(root, '')))).toEqual(
      []
    );
  });

  test.describe('a link that opens once', () => {
    // Its 409 before the click, and its 404 once spent.
    test.use({ allowedErrors: [/\/shares\/[A-Za-z0-9_-]{22}: .* status of 40[49]/] });

    test('a link with a password that opens once', async ({ page, newContext }) => {
      const root = await claimNew(page);
      await editor(page).fill('secret');
      await expect(status(page)).toHaveText('saved');

      await page.getByRole('button', { name: 'share', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'read-only links' });
      await expect(dialog.getByRole('combobox', { name: 'lasts' })).toHaveValue('1 week');
      await dialog.getByRole('checkbox', { name: "opens once, then it's gone" }).check();
      await dialog.getByLabel('password, if it needs one').fill('short');
      await dialog.getByRole('button', { name: 'new link', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('at least 8');
      await dialog.getByLabel('password, if it needs one').fill('correct horse');
      await dialog.getByRole('button', { name: 'new link', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'copied', exact: true })).toBeVisible();
      await expect(dialog.getByText(/, until .*, opens once, password$/)).toBeVisible();
      await expectAccessible(page, 'share dialog, a link with a password');
      const url = await page.evaluate(() => navigator.clipboard.readText());
      expect(url).toMatch(new RegExp(`/_/${root}/s/[A-Za-z0-9_-]{22}#![A-Za-z0-9_-]{43}$`));

      // Its password asked, then a click before it's spent; a wrong password
      // after that can be tried again, the copy kept in the page.
      const reader = await (await newContext()).newPage();
      await reader.goto(url);
      const password = reader.getByLabel('this link needs a password');
      await password.fill('wrong password');
      await password.press('Enter');
      await expect(reader.getByText(/^this link opens once/)).toBeVisible();
      await expectAccessible(reader, 'a link that opens once');
      await reader.getByRole('button', { name: 'open it' }).click();
      await expect(reader.getByRole('alert')).toHaveText(
        '► wrong password, or the link was cut short'
      );
      await password.fill('correct horse');
      await password.press('Enter');
      await expect(reader.locator('pre')).toHaveText('secret');

      // Spent: for the next reader, and gone from the owner's list.
      const late = await (await newContext()).newPage();
      await late.goto(url);
      await late.getByLabel('this link needs a password').fill('correct horse');
      await late.getByLabel('this link needs a password').press('Enter');
      await expect(late.getByRole('alert')).toHaveText(
        '► this link expired, was revoked, or never was'
      );
      await dialog.getByRole('button', { name: 'close', exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.getByRole('button', { name: 'share', exact: true }).click();
      await expect(dialog.getByText('no links yet.')).toBeVisible();
    });
  });

  test("saving a pad that exists doesn't change the root's list", async ({ page }) => {
    const root = await claimNew(page);
    await editor(page).fill('top');
    await expect(status(page)).toHaveText('saved');
    await page.goto(padUrl(`${root}/sub`));
    await opened(page);
    await editor(page).fill('below');
    await expect(status(page)).toHaveText('saved');
    await page.getByRole('navigation', { name: 'path' }).getByRole('link', { name: root }).click();
    await opened(page);
    await expect(editor(page)).toHaveValue('top');

    // From here no pad is made or emptied: every move asks the list and gets 304.
    const lists: number[] = [];
    page.on('response', (r) => {
      if (new URL(r.url()).pathname === `/_/${root}/pads`) lists.push(r.status());
    });
    const finder = page.getByRole('combobox', { name: `find or make a pad under ${root}` });
    for (const text of ['top 2', 'top 3']) {
      await editor(page).fill(text);
      await expect(status(page)).toHaveText('saved');
      await finder.click();
      await finder.fill('sub');
      await finder.press('Enter');
      await expect(page).toHaveURL(`/${root}#sub`);
      await opened(page);
      await page
        .getByRole('navigation', { name: 'path' })
        .getByRole('link', { name: root })
        .click();
      await opened(page);
      await expect(editor(page)).toHaveValue(text);
    }
    expect(lists).toEqual([304, 304, 304, 304]);
  });

  test('an address from before the path moved after the #', async ({ page }) => {
    const root = await claimNew(page);
    await page.goto(padUrl(`${root}/old`));
    await opened(page);
    await editor(page).fill('kept');
    await expect(status(page)).toHaveText('saved');
    // /root/old: the server sends it on to /root#old.
    await page.goto(`/${root}/old`);
    await expect(page).toHaveURL(`/${root}#old`);
    await opened(page);
    await expect(editor(page)).toHaveValue('kept');
  });
});

test('a dialog keeps Tab inside, and Escape gives the pad back its focus', async ({ page }) => {
  await claimNew(page);
  await page.getByRole('button', { name: 'delete', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: /^delete \// });
  const cancel = dialog.getByRole('button', { name: 'cancel', exact: true });
  const remove = dialog.getByRole('button', { name: 'delete', exact: true });
  // The server's grace (e2e/pad-config.json), not a number of its own.
  await expect(dialog).toContainText('for 14 days its password reclaims');
  // Cancel first, so a stray Enter deletes nothing.
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(remove).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(remove).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(editor(page)).toBeFocused();
});

test('a pad written another way is the same pad, and its address says so', async ({ page }) => {
  const root = await claimNew(page);
  await page.goto(padUrl(`${root}/todo`));
  await opened(page);
  await editor(page).fill('milk');
  await expect(status(page)).toHaveText('saved');

  // The server moves the root, the page the rest after the `#`.
  await page.goto(`/${root.toUpperCase()}#ToDo`);
  await expect(page).toHaveURL(padUrl(`${root}/todo`));
  await opened(page);
  await expect(editor(page)).toHaveValue('milk');
});

test('an earlier text restored, then one from before the pad was emptied', async ({ page }) => {
  await claimNew(page);
  await editor(page).fill('first');
  await expect(status(page)).toHaveText('saved');
  // Nothing kept yet: the save over "first" keeps it.
  await editor(page).fill('second');
  await expect(status(page)).toHaveText('saved');

  const history = page.getByRole('button', { name: 'history', exact: true });
  const dialog = page.getByRole('dialog', { name: /^history of / });
  const versions = dialog.getByRole('listitem');
  const shown = dialog.getByRole('textbox', { name: /^the version from / });
  await history.click();
  await expect(versions).toHaveCount(1);
  await versions.first().getByRole('button').click();
  await expect(shown).toHaveValue('first');
  await expectAccessible(page, 'history dialog, a version picked');
  await dialog.getByRole('button', { name: 'restore', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(editor(page)).toHaveValue('first');
  await expect(status(page)).toHaveText('saved');

  // The restore kept "second", however recent.
  await history.click();
  await expect(versions).toHaveCount(2);
  await versions.first().getByRole('button').click();
  await expect(shown).toHaveValue('second');
  await dialog.getByRole('button', { name: 'close', exact: true }).click();

  // Emptied: its last text is kept, and brings it back.
  await editor(page).fill('');
  await expect(status(page)).toHaveText('saved');
  await page.reload();
  await opened(page);
  await expect(editor(page)).toHaveValue('');
  await history.click();
  await expect(versions).toHaveCount(3);
  await versions.first().getByRole('button').click();
  await expect(shown).toHaveValue('first');
  await dialog.getByRole('button', { name: 'restore', exact: true }).click();
  await expect(editor(page)).toHaveValue('first');
  await expect(status(page)).toHaveText('saved');
  await page.reload();
  await opened(page);
  await expect(editor(page)).toHaveValue('first');
});

test.describe('a revoked link', () => {
  test.use({
    permissions: ['clipboard-read', 'clipboard-write'],
    allowedErrors: [/\/shares\/[A-Za-z0-9_-]{22}: .* status of 404/]
  });

  test('stops working, and leaves the list', async ({ page, newContext }) => {
    await claimNew(page);
    await editor(page).fill('gone soon');
    await expect(status(page)).toHaveText('saved');
    await page.getByRole('button', { name: 'share', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'read-only links' });
    await dialog.getByRole('button', { name: 'new link', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'copied', exact: true })).toBeVisible();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    await dialog.getByRole('button', { name: 'revoke', exact: true }).click();
    await expect(dialog.getByText('no links yet.')).toBeVisible();
    await expect(dialog.getByRole('alert')).toBeHidden();
    const reader = await (await newContext()).newPage();
    await reader.goto(url);
    await expect(reader.getByRole('alert')).toHaveText(
      '► this link expired, was revoked, or never was'
    );
  });
});
