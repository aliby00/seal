// Rasterises the site's own icon (src/app/icon.svg) into the extension's
// toolbar and store icons. Run once after the mark changes:
//   node scripts/extension-icons.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const svg = await readFile(`${root}src/app/icon.svg`, 'utf8');
const SIZES = [16, 32, 48, 128];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.locator('svg').screenshot({
      path: `${root}extension/icons/seal-${size}.png`,
      omitBackground: true,
    });
    console.log(`extension/icons/seal-${size}.png`);
  }
} finally {
  await browser.close();
}
