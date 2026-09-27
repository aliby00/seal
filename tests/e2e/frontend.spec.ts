import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const token = '0xd0c538e01a22ebf8502b4dc3a92026cec870cec6';
const explanation =
  'Ce qui est rassurant.\n\nLe créateur a lancé plusieurs tokens.\n\nCe qui mérite attention.\n\nLa concentration reste à documenter.\n\nLà où les signaux divergent.\n\nLe volume observé ne suffit pas à expliquer la distribution.';
const report = {
  token,
  explanation,
  completeness: 'partial',
  sources: [
    {
      name: 'robinhood-rpc',
      note: 'Fenêtre scannée : blocs 100 à 200. Historique antérieur non couvert.',
    },
    { name: 'blockscout', note: 'Aucune clé API.' },
    { name: 'dexscreener' },
  ],
  offline: false,
  costUsd: 0.019,
  collectedAt: '2026-09-27T00:20:04.965Z',
};
async function submit(page: Page) {
  await page.getByLabel('L’adresse du token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Lire l’analyse' }).click();
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
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Aller à l’analyse' })).toBeFocused();
  await page.getByRole('button', { name: 'Lire l’analyse' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('40 caractères');
  expect(requests).toBe(0);
  await expect(page.getByLabel('L’adresse du token', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Utiliser un exemple' }).click();
  await expect(page.getByLabel('L’adresse du token', { exact: true })).toHaveValue(token);
  expect(requests).toBe(0);
  await expect(page.getByText('Environnement : staging')).toBeVisible();
  await expect(page.getByText('Ce n’est pas un conseil financier.')).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Analyse en cours' })).toBeDisabled();
  release();
  await expect(page.getByRole('article')).toBeVisible();
  const text = await page.getByRole('article').innerText();
  expect(text.indexOf('Une lecture partielle')).toBeLessThan(text.indexOf('Le créateur a lancé'));
  expect(text.indexOf('Historique antérieur non couvert')).toBeLessThan(
    text.indexOf('Le créateur a lancé'),
  );
  await expect(page.locator('.divergent')).toHaveCount(1);
  await expect(page.getByText('Sources du rapport dans son ensemble.')).toBeVisible();
  await page.locator('summary').click();
  await expect(page.getByText('Sources du rapport dans son ensemble.')).toBeHidden();
  await page.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Sources du rapport dans son ensemble.')).toBeVisible();
  await expect(page.getByText('Coût de cette requête : 0.0190 $')).toBeVisible();
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
      explanation: 'Faits bruts.\n\nDeuxième paragraphe.\n\nTroisième paragraphe.',
      sources: [],
    });
    await page.goto('/');
    await submit(page);
    const article = page.getByRole('article');
    await expect(article).toBeVisible();
    const text = await article.innerText();
    expect(text.indexOf('Mode hors-ligne')).toBeLessThan(text.indexOf('Faits bruts.'));
    await expect(page.locator('.divergent')).toHaveCount(0);
    await expect(page.locator('.explanation p')).toHaveCount(3);
    await expect(page.getByText('aucun coût : aucun appel au modèle')).toBeVisible();
    await expect(
      page.getByText(
        completeness === 'full' ? 'Toutes les sources ont répondu.' : 'Aucune source exploitable.',
        { exact: true },
      ),
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
      await page.getByRole('button', { name: 'Réessayer' }).click();
      await expect(page.getByRole('article')).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0);
    }
  });
}

test('network failure can be retried without inventing a divergence section', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/analyze', (route) => route.abort());
  await page.goto('/');
  await submit(page);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('connexion');
  await page.unroute('**/api/analyze');
  await mockReport(page, {
    explanation: 'Un paragraphe sans titre.\n\nUn autre.\n\nUn troisième sans qualification.',
  });
  await page.getByRole('button', { name: 'Réessayer' }).click();
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
  await expect(page.getByRole('status')).toContainText('plus de temps que prévu');
  await page.clock.fastForward(75_000);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('trop de temps');
  await page.unroute('**/api/analyze');
  await mockReport(page);
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(page.getByRole('article')).toBeVisible();
});

test('mountain entrance advances with native scroll, reveals the app, and reverses', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Chaque token cache une autre histoire.' }),
  ).toBeVisible();
  await accessible(page);
  const distance = await page
    .locator('.scroll-journey')
    .evaluate((element) => element.clientHeight - window.innerHeight);
  await page.evaluate((y) => window.scrollTo(0, y), distance * 0.5);
  await expect
    .poll(() =>
      page
        .locator('.immersive-root')
        .evaluate((element) =>
          Number((element as HTMLElement).style.getPropertyValue('--camera-scale')),
        ),
    )
    .toBeGreaterThan(3);
  await page.evaluate((y) => window.scrollTo(0, y), distance + 10);
  await expect(page.locator('.analysis-world')).toHaveCSS('opacity', '1');
  await expect(page.getByLabel('L’adresse du token', { exact: true })).toBeVisible();
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
  await page.getByRole('link', { name: 'Ouvrir SEAL' }).click();
  await expect(page.locator('.analysis-world')).toHaveCSS('opacity', '1');
});

test('reduced motion keeps a static entrance and direct keyboard access to the analysis', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.mountain-scene')).toHaveCSS('transform', 'none');
  await expect(page.locator('.portal-world')).toBeHidden();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Aller à l’analyse' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#analysis')).toBeFocused();
  await expect(page.locator('.analysis-world')).toHaveCSS('opacity', '1');
  await expect(page.getByLabel('L’adresse du token', { exact: true })).toBeVisible();
});
