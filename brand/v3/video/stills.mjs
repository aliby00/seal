import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import path from 'node:path';
const shots = process.argv.slice(2).map((s) => s.split(':'));
const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts') });
for (const [id, frame] of shots) {
  const composition = await selectComposition({ serveUrl, id });
  await renderStill({
    composition,
    serveUrl,
    output: `${'stills'}/${id}-${frame}.png`,
    frame: Number(frame),
  });
  console.log('ok', id, frame);
}
