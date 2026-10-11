import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 5591;
// A database of its own, emptied by the server's command on every run.
const DB = join(tmpdir(), `pad-e2e-${PORT}.db`);

// The production build end to end, in Chromium: the save loop, whole flows,
// the CSP and axe. Locally it drives the system's Chromium (CHROMIUM_PATH to
// point elsewhere, or empty for Playwright's own, as CI downloads it).
const chromium = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium';

export default defineConfig({
  testDir: 'e2e',
  // Not *.test.ts: `bun test` would pick those up.
  testMatch: '*.e2e.ts',
  // Each test claims a root of its own, so tests share only the server.
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The save loop's retries and polls wait out real seconds.
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromium ? { executablePath: chromium } : {}
      }
    }
  ],
  webServer: {
    // Built here, since building loads the server code, which opens the
    // database. The build is production's: __Host- cookies, which Chromium
    // takes over http on localhost.
    command: `rm -f ${DB} ${DB}-wal ${DB}-shm && bun run build && bun build/index.js`,
    env: { PAD_DB: DB, HOST: '127.0.0.1', PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/_/limits`,
    reuseExistingServer: false,
    timeout: 300_000
  }
});
