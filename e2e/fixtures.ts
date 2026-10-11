import AxeBuilder from '@axe-core/playwright';
import {
  test as base,
  expect,
  type BrowserContext,
  type BrowserContextOptions,
  type Page
} from '@playwright/test';

export { expect };

/** Every root a test claims gets this password. */
export const PASSWORD = 'correct horse battery';

/** A root no other test, or earlier run, has claimed. */
export const freshRoot = () =>
  `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Collects console errors, uncaught exceptions and CSP violations from every
 * page of `context`. A CSP violation logs a console error of its own too;
 * the listener makes sure one blocked by a directive that doesn't still shows.
 */
async function watch(context: BrowserContext, errors: string[]) {
  context.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.location().url}: ${m.text()}`);
  });
  context.on('weberror', (e) => errors.push(`uncaught: ${e.error().message}`));
  await context.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP violation: ${e.effectiveDirective} blocked ${e.blockedURI}`)
    )
  );
}

export const test = base.extend<{
  /** Console errors a test causes on purpose, such as the failures it has the server answer. */
  allowedErrors: RegExp[];
  errors: string[];
  /** Another browser: no cookies, no keys. */
  newContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
  /** Fails the test on any console error, uncaught exception or CSP violation not allowed. */
  noErrors: void;
}>({
  allowedErrors: [[], { option: true }],
  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from its first parameter
  errors: async ({}, use) => use([]),
  context: async ({ context, errors }, use) => {
    await watch(context, errors);
    await use(context);
  },
  newContext: async ({ browser, errors }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (options) => {
      const context = await browser.newContext(options);
      await watch(context, errors);
      opened.push(context);
      return context;
    });
    await Promise.all(opened.map((c) => c.close()));
  },
  noErrors: [
    async ({ errors, allowedErrors }, use) => {
      await use();
      expect(errors.filter((e) => !allowedErrors.some((r) => r.test(e)))).toEqual([]);
    },
    { auto: true }
  ]
});

/// axe's WCAG 2.1 A and AA rules over the page, once its transitions are
/// done. Soft: a violation is reported, and the flow goes on to the next page.
export async function expectAccessible(page: Page, where: string) {
  // Text mid-fade would fail the contrast check.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => {}))
    )
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect
    .soft(
      violations.map((v) => ({ rule: v.id, targets: v.nodes.map((n) => n.target.join(' ')) })),
      `axe on ${where}`
    )
    .toEqual([]);
}

export const editor = (page: Page) => page.getByRole('textbox', { name: 'pad', exact: true });
/** The editor's status: saved, unsaved, saving…, or an error. */
export const status = (page: Page) => page.locator('header [aria-live="polite"]');

/** Waits for the pad to be fetched and open for typing. */
export async function opened(page: Page) {
  await expect(status(page)).toHaveText('saved');
  await expect(editor(page)).toBeEditable();
}

/** Claims `root` from its gate, which `page` must be on or about to show. */
export async function claim(page: Page, root: string) {
  await expect(page.getByRole('heading', { level: 1, name: `/${root} is free` })).toBeVisible();
  await page.getByLabel('password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('again', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'claim', exact: true }).click();
  await opened(page);
}

/** Opens a new root and claims it. */
export async function claimNew(page: Page) {
  const root = freshRoot();
  await page.goto('/' + root);
  await claim(page, root);
  return root;
}

export async function unlock(page: Page, root: string) {
  await expect(page.getByRole('heading', { level: 1, name: `/${root} is locked` })).toBeVisible();
  await page.getByLabel('password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'unlock', exact: true }).click();
  await opened(page);
}

/**
 * What the server has for `path`, as the app reads it: a new tab of the same
 * browser, which opens the pad from the server, untouched by `page.route`s.
 */
export async function stored(context: BrowserContext, path: string) {
  const page = await context.newPage();
  await page.goto('/' + path);
  await opened(page);
  const text = await editor(page).inputValue();
  await page.close();
  return text;
}

/** Matches a pad's own route, `/_/<root>/pads/<id>`. */
export const PAD_ROUTE = /\/_\/[^/]+\/pads\/[A-Za-z0-9_-]{43}$/;

/** When each save (PUT or DELETE of a pad) left `page`, in ms, routed or not. */
export function saves(page: Page) {
  const at: number[] = [];
  page.on('request', (r) => {
    if (['PUT', 'DELETE'].includes(r.method()) && PAD_ROUTE.test(new URL(r.url()).pathname))
      at.push(Date.now());
  });
  return at;
}
