import { test as base, expect } from '@playwright/test';
import { claimNew } from './fixtures.ts';

// What stands between a string and a script on pad's pages, checked on the
// real build: the CSP's directives, and Trusted Types refusing a string where
// HTML goes. The rules: CONTRIBUTING.org, XSS.

base('the CSP allows no inline or foreign script', async ({ request }) => {
  for (const path of ['/', '/_/about', '/somewhere']) {
    const csp = (await request.get(path)).headers()['content-security-policy'];
    const script = csp.match(/script-src ([^;]*)/)![1].split(' ');
    expect(script.filter((s) => !s.startsWith("'nonce-"))).toEqual([
      "'self'",
      "'wasm-unsafe-eval'"
    ]);
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toMatch(/(^|; )trusted-types svelte-trusted-html(;|$)/);
  }
});

base('features pad never uses are refused', async ({ request }) => {
  const policy = (await request.get('/')).headers()['permissions-policy'];
  for (const feature of ['camera', 'microphone', 'geolocation', 'usb'])
    expect(policy).toContain(`${feature}=()`);
});

base('a string given as HTML throws, in the pad itself', async ({ page }) => {
  await claimNew(page);
  const refused = await page.evaluate(() => {
    const div = document.createElement('div');
    try {
      // eslint-disable-next-line no-restricted-syntax -- the sink is what's tested.
      div.innerHTML = '<img src=x onerror=alert(1)>';
      return null;
    } catch (e) {
      return (e as Error).name;
    }
  });
  expect(refused).toBe('TypeError');
});
