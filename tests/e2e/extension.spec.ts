import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';

/**
 * The unpacked extension in a real Chromium. A local server stands in for
 * both DexScreener (the browser resolves dexscreener.com to it) and the
 * /api/glance endpoint, so nothing here reaches the real sites.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = path.join(ROOT, 'tests/e2e/fixtures/dexscreener-pair.html');
const PAIR = '0x7f8271c1a7a6a434f33b0babc15bf2980a0dcb4196848b4f7e789a7fd73a5350';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x10E848F9d5073D670201b111f1ba3D1C5bE6f18B';

function glance(name: string, symbol: string, token = TOKEN) {
  return {
    token,
    name,
    symbol,
    collectedAt: '2026-10-01T00:00:00.000Z',
    url: `https://sealauth.dev/?token=${TOKEN}#analysis`,
    cached: false,
    glance: {
      headline: 'The creator sold into the pool on 7 of 10 launches checked.',
      items: [
        {
          id: 'sales',
          tone: 'attention',
          figure: '7/10',
          title: 'The creator sold into the pool on 7 of 10 launches checked.',
          detail: 'Sales found in each launch’s first days, confirmed by a trade in the pool.',
          href: '#fact-creator',
        },
        {
          id: 'record',
          tone: 'neutral',
          figure: '76',
          title: 'This creator launched 76 tokens in 12 days.',
          detail: 'Their launch record on chain, this token included.',
          href: '#fact-creator',
        },
        {
          id: 'liquidity',
          tone: 'reassuring',
          figure: '0/8',
          title: 'The launch liquidity was never withdrawn on the 8 launches checked.',
          detail: 'Withdrawals from each launch’s own liquidity position.',
          href: '#fact-creator',
        },
      ],
      unseen: ['live trading on an open market'],
    },
  };
}

let server: Server;
let port = 0;
let dir = '';
let context: BrowserContext;
let worker: Worker;
const asked: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(test.info().project.name !== 'desktop-dark', 'one browser profile is enough');
  const page = await readFile(FIXTURE, 'utf8');
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/glance') {
      asked.push(url.search);
      const origin = req.headers.origin ?? '';
      const cors: Record<string, string> = origin.startsWith('chrome-extension://')
        ? { 'access-control-allow-origin': origin, vary: 'Origin' }
        : {};
      const body =
        url.searchParams.get('pair') === OTHER
          ? glance('Beta', 'BETA', '0x3333333333333333333333333333333333333333')
          : glance('Alpha Token', 'ALP');
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  // A copy of the extension that also runs on the plain-http stand-in.
  dir = await mkdtemp(path.join(tmpdir(), 'seal-ext-'));
  const extension = path.join(dir, 'extension');
  await cp(path.join(ROOT, 'extension'), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.content_scripts[0].matches.push('http://dexscreener.com/robinhood*');
  await writeFile(manifestPath, JSON.stringify(manifest));

  context = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP dexscreener.com 127.0.0.1:${port}`,
      '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
    ],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(
    (base) =>
      (
        globalThis as unknown as {
          chrome: { storage: { local: { set(v: object): Promise<void> } } };
        }
      ).chrome.storage.local.set({ apiBase: base }),
    `http://127.0.0.1:${port}`,
  );
});

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop-dark', 'one browser profile is enough');
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('a token page gets the SEAL pill, which opens the In short card', async () => {
  const page = await context.newPage();
  await page.goto(`http://dexscreener.com/robinhood/${PAIR}`);

  const pill = page.getByRole('button', { name: /Open the SEAL In short card/ });
  await expect(pill).toBeVisible();
  // The pair named in the URL is what is asked, and nothing else from the page.
  await expect.poll(() => asked).toContain(`?pair=${PAIR}`);

  await pill.focus();
  await page.keyboard.press('Enter');
  const card = page.getByRole('dialog', { name: 'Alpha Token · ALP' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Worth attention')).toBeVisible();
  await expect(card.locator('.lead .figure')).toHaveText('7/10');
  await expect(card.locator('.list li')).toHaveCount(2);
  await expect(card).toContainText('Not measured here:');
  await expect(card.getByRole('link', { name: /Full reading on SEAL/ })).toHaveAttribute(
    'href',
    `https://sealauth.dev/?token=${TOKEN}#analysis`,
  );
  await expect(card).not.toContainText(/score\b(?!\.)|\bsafe\b|risky|scam|\brug\b/i);

  // The site's own CSS does not reach the card.
  const font = await card.locator('.headline').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(font).not.toContain('Comic Sans');

  // The page stays usable underneath, and its field is left alone.
  await page.locator('#page-button').click();
  await expect(page.locator('#clicked')).toBeVisible();
  await expect(page.locator('#search')).toHaveValue('0x10e848f9d5073d670201b111f1ba3d1c5be6f18b');

  await page.screenshot({ path: '/tmp/seal-extension-card.png' });

  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(pill).toBeFocused();
  await page.close();
});

test('hovering a link to another token shows a compact card after a pause', async () => {
  const page = await context.newPage();
  await page.goto(`http://dexscreener.com/robinhood/${PAIR}`);
  await expect(page.getByRole('button', { name: /SEAL In short/ })).toBeVisible();

  await page.locator('#tx').hover();
  await page.waitForTimeout(600);
  await expect(page.locator('[data-seal="hover"]')).toHaveCount(0);

  await page.locator('#other').hover();
  const hover = page.getByRole('dialog', { name: 'Beta · BETA' });
  await expect(hover).toBeVisible();
  await expect(hover.locator('.list li')).toHaveCount(2);
  await expect.poll(() => asked).toContain(`?pair=${OTHER}`);

  await page.keyboard.press('Escape');
  await expect(hover).toBeHidden();
  await page.close();
});

test('the popup reads a pasted address', async () => {
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup/popup.html`);
  await page.getByLabel('Token address on Robinhood Chain').fill('not an address');
  await page.getByRole('button', { name: 'Read' }).click();
  await expect(page.getByRole('alert')).toContainText('40 hexadecimal characters');
  await page.getByLabel('Token address on Robinhood Chain').fill(TOKEN);
  await page.getByRole('button', { name: 'Read' }).click();
  await expect(page.getByRole('dialog', { name: 'Alpha Token · ALP' })).toBeVisible();
  await expect(page.getByText('SEAL appears on DexScreener')).toBeVisible();
  await page.close();
});
