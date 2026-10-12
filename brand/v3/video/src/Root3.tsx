import React from 'react';
import { Composition } from 'remotion';
import { FPS } from './lib3';
import { Reveal } from './Reveal';
import { Live } from './Live';
import { Shapes } from './Shapes';
import { Compose } from './Compose';

const H = { width: 1920, height: 1080 };
const V = { width: 1080, height: 1920 };
const sec = (s: number) => Math.round(s * FPS);

const FILMS = [
  ['Reveal', Reveal, 8.0],
  ['Live', Live, 18.4],
  ['Shapes', Shapes, 16.0],
  ['Compose', Compose, 16.6],
] as const;

export const Root3: React.FC = () => (
  <>
    {FILMS.map(([id, C, d]) => (
      <React.Fragment key={id}>
        <Composition id={id} component={C} durationInFrames={sec(d)} fps={FPS} {...H} />
        <Composition id={`${id}-9x16`} component={C} durationInFrames={sec(d)} fps={FPS} {...V} />
      </React.Fragment>
    ))}
  </>
);
