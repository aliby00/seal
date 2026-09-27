import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: 'list',
  outputDir: '/tmp/seal-playwright-results',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: {
    command: 'node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { SEAL_ENV: 'staging' },
  },
  projects: [
    { name: 'desktop-dark', use: { viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' } },
    {
      name: 'mobile-light',
      use: {
        viewport: { width: 375, height: 812 },
        colorScheme: 'light',
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop-light',
      use: { viewport: { width: 1440, height: 1000 }, colorScheme: 'light' },
    },
    {
      name: 'mobile-dark',
      use: {
        viewport: { width: 375, height: 812 },
        colorScheme: 'dark',
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
