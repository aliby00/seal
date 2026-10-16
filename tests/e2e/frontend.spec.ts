import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const token = '0x10e848f9d5073d670201b111f1ba3d1c5be6f18b';
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
  name: 'Alpha Token',
  symbol: 'ALP',
  timeline: [
    {
      address: '0x1000000000000000000000000000000000000001',
      launchedAt: '2026-09-01T00:00:00.000Z',
      block: 100,
      outcome: 'abandoned',
      progress: 0.1,
      sold: true,
      pulled: false,
      current: false,
    },
    {
      address: '0x1000000000000000000000000000000000000002',
      launchedAt: '2026-09-10T00:00:00.000Z',
      block: 150,
      outcome: 'graduated',
      progress: 1,
      sold: false,
      pulled: true,
      current: false,
    },
    {
      address: token,
      launchedAt: '2026-09-20T00:00:00.000Z',
      block: 200,
      outcome: 'active',
      progress: 0.42,
      sold: null,
      pulled: null,
      current: true,
    },
  ],
  specialists: [
    {
      specialist: 'holder-spread',
      title: 'Holder Spread',
      question: 'How much of the supply sits in a few wallets?',
      signal: 'concern',
      facts: ['The largest holder has 31.0% of counted supply; the top 10 have 78.0%.'],
      limits: ['Pool and burn addresses are excluded.'],
    },
    {
      specialist: 'rule-change',
      title: 'Rule Change',
      question: 'Can the rulebook be rewritten after people have bought?',
      signal: 'reassurance',
      facts: ['The rulebook’s code (4120 bytes) has no standard upgrade slot set.'],
      limits: [],
    },
    {
      specialist: 'funding-trace',
      title: 'Funding Trace',
      question: 'Who paid for the creator’s wallet, and did they fund other creators?',
      signal: 'unknown',
      facts: [],
      limits: ['funding was not collected'],
    },
  ],
  facts: {
    creator: {
      measured: true,
      note: 'Scanned range: blocks 100 to 200. Earlier history not covered.',
      address: '0x59a8eb66f90b092c2d1a86531dc3c18e11f0ed34',
      launched: 76,
      detailed: 40,
      graduated: 2,
      abandoned: 36,
      undetermined: 0,
      active: 2,
      checked: 10,
      soldIntoPool: 7,
      liquidityPulled: 1,
      salesChecked: 10,
      liquidityChecked: 8,
      source: 'pons',
      role: null,
      launchContract: null,
      launchesListed: true,
      transactionCount: 860,
    },
    holders: {
      measured: true,
      holderCount: 42,
      top1: 0.31,
      top10: 0.78,
      top: [
        { address: '0x25b2eece475e104c85e79d3be9e29cd06cd982ee', share: 0.31, kind: 'wallet' },
        { address: '0xe08d2285f451ee250b471a5edad1a4b09f22b4fb', share: 0.18, kind: 'wallet' },
        { address: '0xcd9107d2bdfad6b56a7ac235bebe46e555c1801c', share: 0.04, kind: 'contract' },
      ],
    },
    market: {
      measured: false,
      note: 'no pair indexed by DexScreener for this token',
      priceUsd: null,
      liquidityUsd: null,
      volume24hUsd: null,
      buys24h: null,
      sells24h: null,
      fdvUsd: null,
      graduation: { progress: 0.42, thresholdEth: 4.2, graduated: false },
    },
  },
};
test('report draws the measured facts, says what is missing, and gives no score', async ({
  page,
}) => {
  await mockReport(page);
  await page.goto('/#analysis');
  await submit(page);
  const board = page.getByRole('region', { name: 'Measured facts' });
  await expect(board).toBeVisible();
  await expect(board.locator('.fact-big')).toContainText('76 tokens launched');
  await expect(
    board.getByRole('img', { name: /Largest holder 31%, Holders 2 to 10 47%, Everyone else 22%/ }),
  ).toBeVisible();
  await expect(board.getByText('Launches read in detail, in time order')).toBeVisible();
  await expect(board.getByText('No trading pair listed on DexScreener.')).toBeVisible();
  await expect(board.getByText('7 of 10 checked')).toBeVisible();
  await expect(board.getByText('1 of 8 checked')).toBeVisible();
  await expect(board.getByText('Found from their pons launch record.')).toBeVisible();
  await expect(board).not.toContainText(/score|\/10|\/100/i);
  await accessible(page);
});

test('report opens with the token, then asks the ten questions one by one, without a tally', async ({
  page,
}) => {
  await mockReport(page);
  await page.goto('/#analysis');
  await submit(page);
  await expect(page.getByRole('heading', { level: 2, name: /Alpha Token/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Explorer/ })).toHaveAttribute(
    'href',
    `https://robinhoodchain.blockscout.com/token/${token}`,
  );
  const coverage = page.getByRole('list', { name: 'What each source could read' });
  await expect(coverage).toContainText('Market');
  await expect(coverage).toContainText('Not measured');

  const panel = page.getByRole('region', { name: 'Asked of every token, answered one by one.' });
  await expect(panel).toBeVisible();
  // Every answer carries an icon and a word; colour is never the only carrier.
  await expect(panel.getByText('Worth attention')).toBeVisible();
  await expect(panel.getByText('Rules a mechanism out')).toBeVisible();
  await expect(panel.getByText('Not measured')).toBeVisible();
  // Nothing adds the answers up.
  await expect(panel).not.toContainText(/\d+\s*(?:\/|of|out of)\s*10\b|score|safe|risky/i);

  await expect(panel.getByText('Pool and burn addresses are excluded.')).toBeHidden();
  await panel.getByRole('button', { name: 'Open all' }).click();
  await expect(panel.getByText('Pool and burn addresses are excluded.')).toBeVisible();
  await expect(panel.getByText('What it could not see').first()).toBeVisible();
  await accessible(page);
});

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
  await page.locator('.sources summary').click();
  await expect(page.getByText('Sources apply to the report as a whole.')).toBeHidden();
  await page.locator('.sources summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Sources apply to the report as a whole.')).toBeVisible();
  await expect(page.getByText('Request cost: $0.0190')).toBeVisible();
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
    await expect(page.getByText('No cost: no model call.')).toBeVisible();
    await expect(
      page.getByText(completeness === 'full' ? 'All sources responded.' : 'No usable sources.', {
        exact: true,
      }),
    ).toBeVisible();
    await accessible(page);
  });
}

for (const status of [400, 403, 404, 413, 415, 429, 502, 500]) {
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
    if (status === 429) {
      await expect(
        page.getByText('Too many analyses from this connection.', { exact: false }),
      ).toBeVisible();
    }
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
  await page.clock.runFor(31_000);
  await expect(page.getByRole('status')).toContainText('longer than expected');
  await page.clock.fastForward(60_000);
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
  const scaleBeforeHandoff = await page
    .locator('.immersive-root')
    .evaluate((element) =>
      Number((element as HTMLElement).style.getPropertyValue('--camera-scale')),
    );
  await page.evaluate((y) => window.scrollTo(0, y), distance + 10);
  await expect
    .poll(() =>
      page
        .locator('.immersive-root')
        .evaluate((element) =>
          Number((element as HTMLElement).style.getPropertyValue('--camera-scale')),
        ),
    )
    .toBeGreaterThan(scaleBeforeHandoff + 0.5);
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
  await expect(page.locator('.reading-sheet')).toContainText('Who holds the supply');
  await expect(page.locator('.method-boundary')).toContainText('incomplete holder data');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('#source-study-detail')).toContainText('DexScreener');
  await expect(page.getByText('Method illustration · no token data displayed')).toBeVisible();
  await accessible(page);
});

test('legal pages are reachable from the footer, flagged as drafts, and accessible', async ({
  page,
}) => {
  await page.goto('/');
  const legal = page.getByRole('contentinfo').getByRole('navigation', { name: 'Legal' });
  for (const [label, path, heading] of [
    ['Terms', '/terms', 'Terms of use'],
    ['Privacy', '/privacy', 'Privacy'],
    ['Disclaimer', '/disclaimer', 'Disclaimer'],
  ] as const) {
    await expect(legal.getByRole('link', { name: label })).toHaveAttribute('href', path);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole('note')).toContainText('Draft — pending legal review');
    // Nothing invented about the company: its details stay as placeholders.
    if (path !== '/disclaimer')
      await expect(page.getByText(/\[COMPANY NAME\]/).first()).toBeVisible();
    await accessible(page);
    await page.goto('/');
  }
  await page.goto('/disclaimer');
  await expect(page.getByText('Not financial advice')).toBeVisible();
});
