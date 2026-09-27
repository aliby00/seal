import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const token = '0xd0c538e01a22ebf8502b4dc3a92026cec870cec6';
const explanation =
  'What is reassuring.\n\nThe creator launched several tokens.\n\nWhat deserves attention.\n\nConcentration requires further documentation.\n\nWhere the signals diverge.\n\nObserved volume does not explain the distribution.';
const report = {
  token,
  explanation,
  completeness: 'partial',
  sources: [
    {
      name: 'robinhood-rpc',
      note: 'Scanned range: blocks 100 to 200. Earlier history not covered.',
    },
    { name: 'blockscout', note: 'No API key.' },
    { name: 'dexscreener' },
  ],
  offline: false,
  costUsd: 0.019,
  collectedAt: '2026-09-27T00:20:04.965Z',
};
async function submit(page: Page) {
  await page.getByLabel('Token address', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Analyze token' }).click();
}
async function mockReport(page: Page, overrides: Partial<typeof report> = {}) {
  await page.route('**/api/analyze', (route) =>
    route.fulfill({ json: { ...report, ...overrides } }),
  );
}
async function accessible(page: Page) {
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test('homepage: keyboard, example, validation without a request, and accessibility', async ({
  page,
}, testInfo) => {
  let requests = 0;
  await page.route('**/api/analyze', (route) => {
    requests++;
    return route.fulfill({ json: report });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to analysis' })).toBeFocused();
  await page.getByRole('button', { name: 'Analyze token' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    '40 hexadecimal characters',
  );
  expect(requests).toBe(0);
  await expect(page.getByLabel('Token address', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Try an example' }).click();
  await expect(page.getByLabel('Token address', { exact: true })).toHaveValue(token);
  expect(requests).toBe(0);
  await expect(page.getByText('Environment: staging')).toBeVisible();
  await expect(page.getByText('Not financial advice.')).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: `/tmp/seal-home-${testInfo.project.name}.png`, fullPage: true });
});

test('loading describes sources; report keeps limits before prose and sources globally', async ({
  page,
}, testInfo) => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/analyze', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ token });
    await pending;
    await route.fulfill({ json: report });
  });
  await page.goto('/');
  await submit(page);
  await expect(page.getByRole('status')).toContainText('Blockscout');
  await expect(page.getByRole('button', { name: 'Analyzing' })).toBeDisabled();
  release();
  await expect(page.getByRole('article')).toBeVisible();
  const text = await page.getByRole('article').innerText();
  expect(text.indexOf('A partial picture')).toBeLessThan(text.indexOf('The creator launched'));
  expect(text.indexOf('Earlier history not covered')).toBeLessThan(
    text.indexOf('The creator launched'),
  );
  await expect(page.locator('.divergent')).toHaveCount(1);
  await expect(page.getByText('Sources apply to the report as a whole.')).toBeVisible();
  await page.locator('summary').click();
  await expect(page.getByText('Sources apply to the report as a whole.')).toBeHidden();
  await page.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Sources apply to the report as a whole.')).toBeVisible();
  await expect(page.getByText('Request cost: 0.0190 $')).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: `/tmp/seal-report-${testInfo.project.name}.png`, fullPage: true });
});

for (const completeness of ['full', 'unavailable']) {
  test(`completeness ${completeness}, offline before prose and no inferred emphasis`, async ({
    page,
  }) => {
    await mockReport(page, {
      completeness,
      offline: true,
      explanation: 'Raw facts.\n\nSecond paragraph.\n\nThird paragraph.',
      sources: [],
    });
    await page.goto('/');
    await submit(page);
    const article = page.getByRole('article');
    await expect(article).toBeVisible();
    const text = await article.innerText();
    expect(text.indexOf('Offline mode')).toBeLessThan(text.indexOf('Raw facts.'));
    await expect(page.locator('.divergent')).toHaveCount(0);
    await expect(page.locator('.explanation p')).toHaveCount(3);
    await expect(page.getByText('no cost: no model call')).toBeVisible();
    await expect(
      page.getByText(completeness === 'full' ? 'All sources responded.' : 'No usable sources.', {
        exact: true,
      }),
    ).toBeVisible();
    await accessible(page);
  });
}

for (const status of [400, 404, 429, 502, 500]) {
  test(`HTTP ${status}: human message, no technical leak, retry when appropriate`, async ({
    page,
  }) => {
    let attempt = 0;
    await page.route('**/api/analyze', (route) => {
      attempt++;
      return route.fulfill(
        attempt === 1 ? { status, json: { error: 'STACK_TRACE_INTERNAL' } } : { json: report },
      );
    });
    await page.goto('/');
    await submit(page);
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
    await expect(page.getByText('STACK_TRACE_INTERNAL')).toHaveCount(0);
    await accessible(page);
    if ([429, 502, 500].includes(status)) {
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByRole('article')).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    }
  });
}

test('network failure can be retried without inventing a divergence section', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/analyze', (route) => route.abort());
  await page.goto('/');
  await submit(page);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('connection');
  await page.unroute('**/api/analyze');
  await mockReport(page, {
    explanation: 'An untitled paragraph.\n\nAnother one.\n\nA third one without an assessment.',
  });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('article')).toBeVisible();
  await expect(page.locator('.divergent')).toHaveCount(0);
});

test('slow response is explained, reduced motion is respected, timeout allows retry', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.route('**/api/analyze', () => {});
  await page.goto('/');
  await submit(page);
  await expect(page.getByRole('status')).toBeVisible();
  await expect(page.locator('.loading-dots')).toHaveCSS('animation-name', 'none');
  await page.clock.runFor(16_000);
  await expect(page.getByRole('status')).toContainText('longer than expected');
  await page.clock.fastForward(75_000);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('too long');
  await page.unroute('**/api/analyze');
  await mockReport(page);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('article')).toBeVisible();
});

test('mountain entrance advances with native scroll, reveals the app, and reverses', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Every token has another story.' })).toBeVisible();
  await accessible(page);
  const distance = await page
    .locator('.scroll-journey')
    .evaluate((element) => element.clientHeight - window.innerHeight);
  await page.evaluate((y) => window.scrollTo(0, y), distance * 0.5);
  await expect(page.locator('.mountain-scene')).toHaveCount(1);
  await expect(page.locator('.world-background > .mountain-scene')).toHaveCount(1);
  await expect(page.locator('.analysis-world')).toHaveCSS('opacity', '1');
  await expect
    .poll(() =>
      page
        .locator('.immersive-root')
        .evaluate((element) =>
          Number((element as HTMLElement).style.getPropertyValue('--camera-scale')),
        ),
    )
    .toBeGreaterThan(1.1);
  await page.evaluate((y) => window.scrollTo(0, y), distance + 10);
  await expect(page.locator('.analysis-world')).toHaveCSS('opacity', '1');
  await expect(page.getByLabel('Token address', { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(() =>
      page
        .locator('.immersive-root')
        .evaluate((element) =>
          Number((element as HTMLElement).style.getPropertyValue('--camera-scale')),
        ),
    )
    .toBe(1);
  await page.getByRole('link', { name: 'Enter SEAL' }).click();
  await expect(page.locator('.analysis-world')).toHaveCSS('opacity', '1');
});

test('reduced motion keeps a static entrance and direct keyboard access to the analysis', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.mountain-scene')).toHaveCSS('transform', 'none');
  await expect(page.locator('.valley-mist')).toBeHidden();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to analysis' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#analysis')).toBeFocused();
  await expect(page.locator('.analysis-world')).toHaveCSS('opacity', '1');
  await expect(page.getByLabel('Token address', { exact: true })).toBeVisible();
});

test('entry links and logo scroll in both directions without losing the address', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Enter SEAL' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.abs(document.getElementById('analysis')!.getBoundingClientRect().top),
      ),
    )
    .toBeLessThan(2);
  await expect(page.locator('#analysis')).toBeFocused();
  await page.getByLabel('Token address', { exact: true }).fill(token);
  await page.getByRole('link', { name: 'SEAL', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(2);
  await page.getByRole('link', { name: 'Enter SEAL' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.abs(document.getElementById('analysis')!.getBoundingClientRect().top),
      ),
    )
    .toBeLessThan(2);
  await expect(page.getByLabel('Token address', { exact: true })).toHaveValue(token);
});

test('source study exposes each method using accessible controls', async ({ page }) => {
  await page.goto('/#analysis');
  const controls = page.getByRole('group', { name: 'Explore sources' });
  await controls.getByRole('button', { name: 'Holders' }).click();
  await expect(controls.getByRole('button', { name: 'Holders' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('#source-study-detail')).toContainText('Blockscout');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('#source-study-detail')).toContainText('DexScreener');
  await expect(page.getByText('Method illustration · no token data displayed')).toBeVisible();
  await accessible(page);
});
