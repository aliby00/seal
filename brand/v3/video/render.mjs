import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const ids = process.argv.slice(2);
mkdirSync('out', { recursive: true });
const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts') });
for (const id of ids) {
  const composition = await selectComposition({ serveUrl, id });
  const t0 = Date.now();
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    crf: 20,
    pixelFormat: 'yuv420p',
    outputLocation: `${'out'}/seal-${id.toLowerCase()}.mp4`,
    concurrency: 6,
  });
  console.log('ok', id, ((Date.now() - t0) / 1000).toFixed(0) + 's');
}
