import type { Page, Route } from '@playwright/test';
import {
  claimNew,
  editor,
  expect,
  opened,
  PAD_ROUTE,
  saves,
  status,
  stored,
  test,
  unlock
} from './fixtures.ts';

// Pad.svelte's timings.
const SAVE_DELAY = 600;
const POLL = 5000;
const RETRY = 5000;

/** The failures these tests have the server answer, which Chromium logs. */
const REFUSED = /Failed to load resource: the server responded with a status of (500|429|413)/;

/** Answers a save with `status` and a message, as the server words its errors. */
const refuse = (route: Route, status: number, message: string, headers = {}) =>
  route.fulfill({
    status,
    headers,
    contentType: 'application/json',
    body: JSON.stringify({ status, message })
  });

/** Hands each save (PUT) to `handle`, numbered from 0; everything else goes through. */
async function onSave(page: Page, handle: (route: Route, n: number) => Promise<void>) {
  let n = 0;
  await page.route(PAD_ROUTE, (route) =>
    route.request().method() === 'PUT' ? handle(route, n++) : route.fallback()
  );
}

test('saves once typing pauses', async ({ page, context }) => {
  const root = await claimNew(page);
  const at = saves(page);
  // Keys closer together than SAVE_DELAY: one save, after the last. The last
  // without a delay, which would hold it down after its input.
  await editor(page).pressSequentially('hell', { delay: SAVE_DELAY / 4 });
  await editor(page).press('o');
  const typed = Date.now();
  await expect(status(page)).toHaveText('saved');
  expect(at).toHaveLength(1);
  // Less a little for the time between the last input and `typed`.
  expect(at[0] - typed).toBeGreaterThanOrEqual(SAVE_DELAY - 150);
  expect(await stored(context, root)).toBe('hello');
});

test('typing during a slow save saves again, with the latest text', async ({ page, context }) => {
  const root = await claimNew(page);
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  let held = 0;
  await onSave(page, async (route, n) => {
    if (n === 0) {
      held++;
      await slow;
    }
    await route.continue();
  });
  const at = saves(page);

  await editor(page).fill('one');
  await expect.poll(() => held).toBe(1);
  await expect(status(page)).toHaveText('saving…');
  await editor(page).fill('one two');
  // While the first save hangs, no second one starts alongside it.
  await page.waitForTimeout(SAVE_DELAY * 2);
  expect(at).toHaveLength(1);

  release();
  await expect.poll(() => at.length).toBe(2);
  await expect(status(page)).toHaveText('saved');
  expect(await stored(context, root)).toBe('one two');
});

test.describe('refused saves', () => {
  test.use({ allowedErrors: [REFUSED] });

  test('a failed save retries, and the text arrives', async ({ page, context }) => {
    const root = await claimNew(page);
    await onSave(page, (route, n) => (n === 0 ? refuse(route, 500, 'boom') : route.continue()));
    const at = saves(page);

    await editor(page).fill('retry me');
    await expect(status(page)).toHaveText('► boom, retrying');
    await expect(status(page)).toHaveText('saved', { timeout: RETRY + 3000 });
    expect(at).toHaveLength(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(RETRY - 100);
    expect(await stored(context, root)).toBe('retry me');
  });

  test('a 429 waits for its Retry-After, not the usual retry', async ({ page, context }) => {
    const root = await claimNew(page);
    await onSave(page, (route, n) =>
      n === 0
        ? refuse(route, 429, 'too many requests, wait 2s', { 'retry-after': '2' })
        : route.continue()
    );
    const at = saves(page);

    await editor(page).fill('after a wait');
    await expect(status(page)).toHaveText('► too many requests, wait 2s, retrying');
    await expect(status(page)).toHaveText('saved', { timeout: RETRY + 3000 });
    expect(at).toHaveLength(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(2000 - 100);
    expect(at[1] - at[0]).toBeLessThan(RETRY - 500);
    expect(await stored(context, root)).toBe('after a wait');
  });

  test('a 413 is not retried; the next edit saves again', async ({ page, context }) => {
    const root = await claimNew(page);
    await onSave(page, (route, n) => (n === 0 ? refuse(route, 413, 'too big') : route.continue()));
    const at = saves(page);

    await editor(page).fill('too much');
    await expect(status(page)).toHaveText('► too big, not saved');
    // No retry: the same text can't fit.
    await page.waitForTimeout(RETRY + 1000);
    expect(at).toHaveLength(1);

    // A change saves again.
    await editor(page).press('End');
    await editor(page).press('Backspace');
    await expect(status(page)).toHaveText('saved');
    expect(at).toHaveLength(2);
    expect(await stored(context, root)).toBe('too muc');
  });

  test('a 413 without a message says what happened', async ({ page }) => {
    await claimNew(page);
    await onSave(page, (route) => route.fulfill({ status: 413, body: 'Payload Too Large' }));
    await editor(page).fill('too much');
    await expect(status(page)).toHaveText('► too big to save, not saved');
  });
});

test('hiding the tab saves straight away', async ({ page, context }) => {
  const root = await claimNew(page);
  const at = saves(page);
  await editor(page).fill('hidden');
  const typed = Date.now();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden'
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => at.length).toBe(1);
  // Before SAVE_DELAY would have.
  expect(at[0] - typed).toBeLessThan(SAVE_DELAY - 150);
  await expect(status(page)).toHaveText('saved');
  // And the pending delayed save doesn't send it again.
  await page.waitForTimeout(SAVE_DELAY * 2);
  expect(at).toHaveLength(1);
  expect(await stored(context, root)).toBe('hidden');
});

test('navigating away saves', async ({ page, context }) => {
  const root = await claimNew(page);
  const at = saves(page);
  await editor(page).fill('leaving');
  // A click from script: the textarea keeps the focus, so it's beforeNavigate
  // that saves, not the blur. Leaving unmounts the editor, and its timer.
  await page.evaluate(() =>
    document.querySelector<HTMLAnchorElement>('nav[aria-label="path"] a[href="/"]')!.click()
  );
  await expect(page.getByRole('heading', { level: 1, name: 'pad' })).toBeVisible();
  await expect.poll(() => at.length).toBe(1);
  expect(await stored(context, root)).toBe('leaving');
});

test.describe('the poll', () => {
  test.use({ allowedErrors: [REFUSED] });

  test("shows another browser's write, never over unsaved edits", async ({ page, newContext }) => {
    test.setTimeout(90_000);
    const root = await claimNew(page);
    const other = await (await newContext()).newPage();
    await other.goto('/' + root);
    await unlock(other, root);

    // Nothing unsaved here: the other's write shows within a poll.
    await editor(other).fill('from the other');
    await expect(status(other)).toHaveText('saved');
    await expect(editor(page)).toHaveValue('from the other', { timeout: POLL + 3000 });
    await expect(status(page)).toHaveText('saved');

    // Unsaved edits here, kept unsaved by a server that refuses them: two
    // polls later they're still what's on screen.
    await onSave(page, (route) => refuse(route, 500, 'down'));
    await editor(page).fill('mine');
    await expect(status(page)).toHaveText('► down, retrying');
    await editor(other).fill('theirs');
    await expect(status(other)).toHaveText('saved');
    await page.waitForTimeout(POLL * 2 + 1000);
    await expect(editor(page)).toHaveValue('mine');

    // The server back: the retry saves them, last write wins, and the other
    // browser, with nothing unsaved, shows them.
    await page.unroute(PAD_ROUTE);
    await expect(status(page)).toHaveText('saved', { timeout: RETRY + 3000 });
    await expect(editor(other)).toHaveValue('mine', { timeout: POLL + 3000 });
    await opened(other);
  });
});
