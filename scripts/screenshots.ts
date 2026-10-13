// README's screenshots: a root of a few pads, made through the page as a
// person would, then a pad with its finder open, on a desktop and a phone.
//
// Run against a build with a throwaway database:
//
//   PAD_DB=/tmp/pad-shots.db HOST=127.0.0.1 PORT=5598 bun build/index.js
//   bun scripts/screenshots.ts http://localhost:5598 docs/screenshots
//
// Chromium from CHROMIUM_PATH, /usr/bin/chromium by default.
import { chromium, devices, type Page } from '@playwright/test';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: bun scripts/screenshots.ts <url> <directory>');

const ROOT = 'notes';
const PASSWORD = 'correct horse battery';
const PADS: [string, string][] = [
  [
    '',
    'this week\n\n+ call the bank about the card\n+ return the library books\n+ fix the back brake\n\nlater\n\n+ plan the trip in may\n+ back up the laptop\n'
  ],
  ['groceries', 'milk\neggs\nbread\ncoffee\nlemons\n'],
  ['reading', '+ the dispossessed\n+ a pattern language\n'],
  ['recipes/bread', '500 g flour\n350 g water\n10 g salt\n5 g yeast\n'],
  ['trip', 'train on the 14th, 9:20\n']
];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium'
});
const editor = (page: Page) => page.getByRole('textbox', { name: 'pad', exact: true });
const saved = (page: Page) =>
  page
    .locator('header [aria-live="polite"]')
    .filter({ hasText: /^saved$/ })
    .waitFor();

const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
const page = await context.newPage();
await page.goto(`${base}/${ROOT}`);
await page.getByLabel('password', { exact: true }).fill(PASSWORD);
await page.getByLabel('again', { exact: true }).fill(PASSWORD);
await page.getByRole('button', { name: 'claim', exact: true }).click();
await saved(page);
for (const [path, text] of PADS) {
  await page.goto(`${base}/${ROOT}${path ? '#' + path : ''}`);
  await saved(page);
  await editor(page).fill(text);
  await saved(page);
}

/** The root pad open: a phone's header has no room for the status. */
const shown = (page: Page) =>
  page.waitForFunction(
    (text) => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value === text,
    PADS[0][1]
  );

/** The root pad, its finder open on `re`. */
async function shoot(page: Page, file: string) {
  await page.goto(`${base}/${ROOT}`);
  await shown(page);
  const finder = page.getByRole('combobox', { name: `find or make a pad under ${ROOT}` });
  await finder.click();
  await finder.fill('re');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${out}/${file}` });
}

await shoot(page, 'desktop.png');
// The keys are non-extractable: the phone unlocks with the password.
const phone = await (await browser.newContext(devices['Pixel 7'])).newPage();
await phone.goto(`${base}/${ROOT}`);
await phone.getByLabel('password', { exact: true }).fill(PASSWORD);
await phone.getByRole('button', { name: 'unlock', exact: true }).click();
await shown(phone);
await shoot(phone, 'phone.png');
await browser.close();
