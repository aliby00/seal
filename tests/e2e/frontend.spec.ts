import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import solana from './fixtures/solana-analysis.json' with { type: 'json' };

/** The Poor Bull, a pump.fun token, and the first example of the home page. */
const token = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';
const explanation =
  'What is reassuring.\n\nThe creator launched several tokens.\n\nWhat deserves attention.\n\nConcentration requires further documentation.\n\nWhere the signals diverge.\n\nObserved volume does not explain the distribution.';
const report = {
  token,
  explanation,
  completeness: 'partial',
  sources: [
    {
      name: 'solana-rpc',
      note: 'Scanned range: slots 100 to 200. Earlier history not covered.',
    },
    { name: 'dexscreener-solana' },
  ],
  offline: false,
  collectedAt: '2026-09-27T00:20:04.965Z',
  name: 'Alpha Token',
  symbol: 'ALP',
  timeline: [
    {
      address: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
      launchedAt: '2026-09-01T00:00:00.000Z',
      block: 100,
      outcome: 'abandoned',
      progress: 0.1,
      sold: true,
      pulled: false,
      current: false,
    },
    {
      address: 'ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump',
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
      question: 'Can the token’s rules be changed after people have bought?',
      signal: 'reassurance',
      facts: ['Nobody can create more of this token, and nobody can freeze its accounts.'],
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
      note: 'Scanned range: slots 100 to 200. Earlier history not covered.',
      address: 'D234v6HgjNdTfS8vYa3ZfJAF5sSoTVzrKCDmQ2ypCnQK',
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
      source: null,
      role: null,
      launchContract: null,
      launchesListed: true,
      transactionCount: 860,
      launchpad: 'pump.fun',
      creatorFrom: 'launch-record',
    },
    holders: {
      measured: true,
      holderCount: 42,
      top1: 0.31,
      top10: 0.78,
      top: [
        { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', share: 0.31, kind: 'wallet' },
        { address: 'Ft1qQLFGbetZTc4gfT5FSyUw3cMc3mq9ZGkwTVLkVgoX', share: 0.18, kind: 'wallet' },
        { address: '52PrpjRXwQZURZbVutzpmg12xiTb7txMYY7DcfShkEZW', share: 0.04, kind: 'contract' },
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
      graduation: null,
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
  await expect(board.locator('.fact-big')).toContainText('76 tokens launched, this one included');
  await expect(
    board.getByRole('img', { name: /Largest holder 31%, Holders 2 to 10 47%, Everyone else 22%/ }),
  ).toBeVisible();
  await expect(board.getByText('Launches read in detail, in time order')).toBeVisible();
  await expect(board.getByText('No trading pair listed on DexScreener.')).toBeVisible();
  await expect(board.getByText('The creator sold some of this token.')).toBeVisible();
  await expect(
    board.getByText('Named as creator by the token’s pump.fun bonding curve.'),
  ).toBeVisible();
  // Addresses are shortened in base58, case kept, and open the Solana Explorer.
  await expect(board.getByRole('link', { name: '9WzD…AWWM' })).toHaveAttribute(
    'href',
    'https://explorer.solana.com/address/9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  );
  await expect(board).not.toContainText(/score|\/10|\/100/i);
  await accessible(page);
});

test('a report a failed read left partial says so in In short, below the findings', async ({
  page,
}) => {
  await mockReport(page, {
    facts: {
      ...report.facts,
      failed: [
        {
          read: 'creator-launches',
          note: 'the SEAL indexer did not answer: the launches it lists could not be read this time',
        },
      ],
    } as typeof report.facts,
  });
  await page.goto('/#analysis');
  await submit(page);
  const notice = page.locator('.glance-partial');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(
    'Partial report: some reads failed this time (the creator’s other launches).',
  );
  await expect(notice).toContainText('Try again in a minute.');
  await expect(page.locator('.glance')).toContainText(
    'some of the places their launches are listed could not be read this time',
  );
  await accessible(page);
});

test('report opens with the token, then gives ten plain checks, without a tally', async ({
  page,
}) => {
  await mockReport(page);
  await page.goto('/#analysis');
  await submit(page);
  await expect(page.getByRole('heading', { level: 2, name: /Alpha Token/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Solana Explorer/ })).toHaveAttribute(
    'href',
    `https://explorer.solana.com/address/${token}`,
  );
  await expect(page.getByRole('link', { name: /DexScreener/ })).toHaveAttribute(
    'href',
    `https://dexscreener.com/solana/${token}`,
  );
  const coverage = page.getByRole('list', { name: 'What each source could read' });
  await expect(coverage).toContainText('Market');
  await expect(coverage).toContainText('Not measured');

  const panel = page.getByRole('region', { name: 'Ten checks, in plain words.' });
  await expect(panel).toBeVisible();
  // Every answer carries an icon and a word; colour is never the only carrier.
  await expect(panel.getByText('Worth attention').first()).toBeVisible();
  await expect(panel.getByText('Reassuring').first()).toBeVisible();
  // Each check has a plain name and a one-line answer.
  await expect(panel.getByText('Supply held by a few')).toBeVisible();
  await expect(
    panel.getByText('Largest holder 31.0% · top 10 78.0% (pools left out)'),
  ).toBeVisible();
  // What could not be measured is gathered in one line, not spread among the answers.
  const unmeasured = panel.locator('.check-unmeasured');
  await expect(unmeasured).toContainText('Not measured for this token');
  await expect(unmeasured).toContainText('Who funded the creator');
  // Nothing adds the answers up.
  await expect(panel).not.toContainText(/\d+\s*(?:\/|of|out of)\s*10\b|score|safe|risky/i);

  await expect(panel.getByText('Pool and burn addresses are excluded.')).toBeHidden();
  await panel.getByText('Supply held by a few').click();
  await expect(panel.getByText('Pool and burn addresses are excluded.')).toBeVisible();
  await expect(panel.getByText('What it could not see').first()).toBeVisible();
  await accessible(page);
});

test('a creator funded by a wallet that funded others: summary line, then the path in its tile', async ({
  page,
}) => {
  const funder = 'BeRNwDN8aGHvxYRVhNyMkF1wsxuEeceux2xn5deFWyEe';
  const above = 'DRXA1H9SjZPyPCEeuAWpfwk8GqVW6dZsKFAtdfpFwApX';
  const linked = {
    ...report,
    specialists: [
      ...report.specialists.filter((a) => a.specialist !== 'funding-trace'),
      {
        specialist: 'funding-trace',
        title: 'Funding Trace',
        question: 'Who paid for the creator’s wallet, and did they fund other creators?',
        signal: 'concern',
        facts: [
          `The wallet that funded the creator (${funder}, 33 transactions) also funded 16 other token creators, linked through 2 funding steps. Together they launched 41 tokens.`,
        ],
        limits: [],
        funding: {
          kind: 'wallet',
          linkedCreators: 16,
          launches: 41,
          depth: 2,
          path: [
            { address: funder, kind: 'wallet', name: null, txCount: 33 },
            { address: above, kind: 'wallet', name: null, txCount: 232 },
          ],
        },
      },
    ],
  };
  await page.route('**/api/analyze', (route) => route.fulfill({ json: linked }));
  await page.goto('/#analysis');
  await submit(page);
  const line = page.locator('.glance a').filter({
    hasText: 'also funded 16 other token creators, who launched 41 tokens between them.',
  });
  await expect(line).toHaveAttribute('href', '#question-funding-trace');
  await line.click();
  const tile = page.locator('#question-funding-trace');
  await expect(tile).toHaveAttribute('open', '');
  const path = tile.getByRole('list').filter({ hasText: 'Creator funded by' });
  await expect(path.getByRole('listitem')).toHaveCount(2);
  await expect(path).toContainText('BeRN…WyEe');
  await expect(path).toContainText('wallet, 33 transactions');
  await expect(path).toContainText('232 transactions');
  await accessible(page);
});

test('a recorded Solana reading draws the mint, the supply by role, the launch and the creator', async ({
  page,
}, testInfo) => {
  // pump-creator-sold, collected on mainnet on 25/11/2026 and written offline
  // (tests/fixtures/solana/collect): the response as /api/analyze serves it.
  await page.route('**/api/analyze', (route) => route.fulfill({ json: solana }));
  await page.goto('/#analysis');
  await submit(page);
  await expect(page.getByRole('heading', { level: 2, name: /The Poor Bull/ })).toBeVisible();
  const board = page.getByRole('region', { name: 'Facts read on Solana' });
  await expect(board).toBeVisible();
  const mint = board.locator('#fact-mint');
  await expect(mint).toContainText('Token-2022');
  await expect(mint).toContainText('metadataPointer');
  await expect(mint.getByRole('list', { name: 'What the mint lets someone do' })).toContainText(
    'Create more tokens',
  );
  await expect(board.locator('#fact-roles')).toContainText('pump.fun bonding curve');
  await expect(board.locator('#fact-launch')).toContainText('Launched on pump.fun');
  await expect(board.locator('#fact-launch')).toContainText('473,491,200');
  await expect(
    board.locator('#fact-launch').getByRole('link', { name: /^5Rftux/ }),
  ).toHaveAttribute('href', /^https:\/\/explorer\.solana\.com\/tx\/5Rftux22/);
  const creator = board.locator('#fact-creator-token');
  await expect(creator).toContainText('Named as creator by the token’s pump.fun bonding curve.');
  await expect(
    creator.getByRole('link', { name: solana.solana.creator.data.address ?? '' }),
  ).toHaveAttribute(
    'href',
    `https://explorer.solana.com/address/${solana.solana.creator.data.address}`,
  );
  await expect(page.getByRole('article')).not.toContainText(
    /blockscout|robinhood|score\b|\bsafe\b/i,
  );
  await accessible(page);
  await page.screenshot({ path: `/tmp/seal-solana-${testInfo.project.name}.png`, fullPage: true });
  await board.screenshot({ path: `/tmp/seal-solana-board-${testInfo.project.name}.png` });
});

test('a ?token= link fills the address and starts the analysis', async ({ page }) => {
  const posted: unknown[] = [];
  await page.route('**/api/analyze', (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: report });
  });
  await page.goto(`/?token=${token}#analysis`);
  await expect(page.getByLabel('Token address', { exact: true })).toHaveValue(token);
  await expect(page.getByRole('article')).toBeVisible();
  expect(posted).toEqual([{ token }]);
});

test('the entrance field starts the analysis, and the reading gets a link to share', async ({
  page,
}) => {
  const posted: unknown[] = [];
  await page.route('**/api/analyze', (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: report });
  });
  await page.goto('/');
  const field = page.getByLabel('Token address to analyze');
  await expect(field).toBeVisible();
  await field.fill('0x10e848f9d5073d670201b111f1ba3d1c5be6f18b');
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.locator('.entrance-error')).toContainText('Enter a Solana token address');
  expect(posted).toEqual([]);
  await field.fill(token);
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByRole('article')).toBeVisible();
  expect(posted).toEqual([{ token }]);
  await expect(page.getByLabel('Token address', { exact: true })).toHaveValue(token);
  expect(page.url().endsWith(`/?token=${token}#analysis`)).toBe(true);
  const share = page.getByRole('group', { name: 'Share this reading' });
  const post = new URL(
    (await share.getByRole('link', { name: /Share on X/ }).getAttribute('href')) ?? '',
  );
  expect(post.origin + post.pathname).toBe('https://x.com/intent/post');
  expect(post.searchParams.get('url')?.endsWith(`/?token=${token}#analysis`)).toBe(true);
  await expect(share.getByRole('button', { name: 'Copy link' })).toBeVisible();
});

test('a running analysis can be cancelled', async ({ page }) => {
  await page.route('**/api/analyze', () => {});
  await page.goto('/');
  await submit(page);
  const status = page.getByRole('status');
  await expect(status).toContainText('usually 20 to 40 s');
  await expect(status).toContainText('Supply held by a few');
  await status.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Token address', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Token address', { exact: true })).toHaveValue(token);
});

test('a ?token= link that is not an address starts nothing', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/analyze', (route) => {
    requests++;
    return route.fulfill({ json: report });
  });
  await page.goto(`/?token=${token}00#analysis`);
  await expect(page.getByLabel('Token address', { exact: true })).toHaveValue('');
  await page.waitForTimeout(300);
  expect(requests).toBe(0);
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
    'Enter a Solana token address',
  );
  expect(requests).toBe(0);
  await expect(page.getByLabel('Token address', { exact: true })).toBeFocused();
  // Each example fills the field and reads the token straight away.
  const examples = page.getByRole('group', { name: 'Or read an example' });
  await expect(examples.getByRole('button')).toHaveCount(3);
  await examples.getByRole('button', { name: /The Poor Bull/ }).click();
  await expect(page.getByLabel('Token address', { exact: true })).toHaveValue(token);
  await expect(page.getByRole('article')).toBeVisible();
  expect(requests).toBe(1);
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
  await expect(page.getByRole('status')).toContainText('read on Solana');
  await expect(page.getByRole('button', { name: 'Analyzing' })).toBeDisabled();
  release();
  await expect(page.getByRole('article')).toBeVisible();
  const text = await page.getByRole('article').innerText();
  // The short version comes first, with what it could not see, before any prose.
  expect(text.indexOf('In short')).toBeLessThan(text.indexOf('Not measured here'));
  expect(text.indexOf('Not measured here')).toBeLessThan(text.indexOf('The creator launched'));
  await expect(page.locator('.glance-lead')).toContainText(
    'The creator sold into the pool on 7 of 10 launches checked.',
  );
  await expect(page.locator('.divergent')).toHaveCount(1);
  await expect(page.getByText('Sources apply to the report as a whole.')).toBeVisible();
  await page.locator('.sources summary').click();
  await expect(page.getByText('Sources apply to the report as a whole.')).toBeHidden();
  await page.locator('.sources summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Sources apply to the report as a whole.')).toBeVisible();
  await expect(page.getByText(/Request cost|no model call/)).toHaveCount(0);
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
    // With measured facts the short version stands in for the banner, except when nothing is usable.
    if (completeness === 'full') await expect(page.locator('.glance')).toBeVisible();
    else await expect(page.getByText('No usable sources.', { exact: true })).toBeVisible();
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
  await page.clock.runFor(46_000);
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
  await expect(page.getByRole('heading', { name: 'Paste a token. Read its story.' })).toBeVisible();
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
        .locator('.world-background')
        .evaluate((element) =>
          Number((element as HTMLElement).style.getPropertyValue('--camera-scale')),
        ),
    )
    .toBeGreaterThan(1.1);
  const scaleBeforeHandoff = await page
    .locator('.world-background')
    .evaluate((element) =>
      Number((element as HTMLElement).style.getPropertyValue('--camera-scale')),
    );
  await page.evaluate((y) => window.scrollTo(0, y), distance + 10);
  await expect
    .poll(() =>
      page
        .locator('.world-background')
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
        .locator('.world-background')
        .evaluate((element) =>
          Number((element as HTMLElement).style.getPropertyValue('--camera-scale')),
        ),
    )
    .toBe(1);
  await page.getByRole('link', { name: 'Scroll to explore' }).click();
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
  await page.getByRole('link', { name: 'Scroll to explore' }).click();
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
  await page.getByRole('link', { name: 'Scroll to explore' }).click();
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
  await expect(page.locator('#source-study-detail')).toContainText('Solana token accounts');
  await expect(page.locator('.reading-sheet')).toContainText('Who holds the supply');
  await expect(page.locator('.method-boundary')).toContainText(
    'only the largest accounts are read',
  );
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('#source-study-detail')).toContainText('DexScreener');
  await expect(page.getByText('Method illustration · no token data displayed')).toBeVisible();
  await accessible(page);
});

test('legal pages are reachable from the footer, final, and accessible', async ({ page }) => {
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
    // No placeholder left for a reader to see.
    await expect(page.getByText(/\[[A-Z ]{4,}\]/)).toHaveCount(0);
    await accessible(page);
    await page.goto('/');
  }
  await page.goto('/disclaimer');
  await expect(page.getByText('Not financial advice')).toBeVisible();
  await page.goto('/terms');
  await expect(page.getByRole('heading', { name: 'What you may not do' })).toBeVisible();
});
