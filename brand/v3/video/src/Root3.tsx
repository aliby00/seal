import React from 'react';
import { Composition } from 'remotion';
import { FPS } from './lib3';
import { Reveal } from './Reveal';
import { Live } from './Live';
import { Shapes } from './Shapes';
import { Compose } from './Compose';
import { Countdown } from './Countdown';
import { Hype } from './Hype';

const H = { width: 1920, height: 1080 };
const V = { width: 1080, height: 1920 };
const sec = (s: number) => Math.round(s * FPS);

const FILMS = [
  ['Reveal', Reveal, 8.0],
  ['Live', Live, 18.4],
  ['Shapes', Shapes, 16.0],
  ['Compose', Compose, 16.6],
  ['Hype', Hype, 14.0],
] as const;

/** Compte à rebours : J-7, J-5, J-3, J-1, puis le jour J. */
const COUNTDOWN = [7, 5, 3, 1, 0] as const;

export const Root3: React.FC = () => (
  <>
    {FILMS.map(([id, C, d]) => (
      <React.Fragment key={id}>
        <Composition id={id} component={C} durationInFrames={sec(d)} fps={FPS} {...H} />
        <Composition id={`${id}-9x16`} component={C} durationInFrames={sec(d)} fps={FPS} {...V} />
      </React.Fragment>
    ))}
    {COUNTDOWN.map((days) => {
      const id = days ? `Countdown-${days}` : 'Launch';
      return (
        <React.Fragment key={id}>
          <Composition
            id={id}
            component={Countdown}
            defaultProps={{ days }}
            durationInFrames={sec(7.6)}
            fps={FPS}
            {...H}
          />
          <Composition
            id={`${id}-9x16`}
            component={Countdown}
            defaultProps={{ days }}
            durationInFrames={sec(7.6)}
            fps={FPS}
            {...V}
          />
        </React.Fragment>
      );
    })}
  </>
);
