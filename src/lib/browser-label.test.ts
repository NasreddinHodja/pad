import { expect, test } from 'bun:test';
import { browserLabel } from './browser-label.ts';
import { LABEL_BYTES } from './crypto.ts';

test("a browser's label is its kind and its system", () => {
  for (const [ua, label] of [
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
      'Edge on Windows'
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
      'Chromium on Android'
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari on iOS'
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Safari on macOS'
    ],
    ['curl/8.0', 'a browser']
  ])
    expect(browserLabel(ua)).toBe(label);
});

test('every label fits the sealed size', () => {
  expect(
    new TextEncoder().encode(browserLabel('Opera OPR/1 Android CrOS')).length
  ).toBeLessThanOrEqual(LABEL_BYTES);
});
