import React from 'react';
import { Composition } from 'remotion';
import { FPS } from './lib';
import { Reuse } from './Reuse';
import { Impersonation } from './Impersonation';
import { Teaser } from './Teaser';

const H = { width: 1920, height: 1080 };
const V = { width: 1080, height: 1920 };
const sec = (s: number) => Math.round(s * FPS);

export const Root: React.FC = () => (
  <>
    <Composition id="Reuse" component={Reuse} durationInFrames={sec(19.6)} fps={FPS} {...H} />
    <Composition id="Reuse-9x16" component={Reuse} durationInFrames={sec(19.6)} fps={FPS} {...V} />
    <Composition
      id="Imperso"
      component={Impersonation}
      durationInFrames={sec(18.4)}
      fps={FPS}
      {...H}
    />
    <Composition
      id="Imperso-9x16"
      component={Impersonation}
      durationInFrames={sec(18.4)}
      fps={FPS}
      {...V}
    />
    <Composition id="Teaser" component={Teaser} durationInFrames={sec(18.1)} fps={FPS} {...H} />
    <Composition
      id="Teaser-9x16"
      component={Teaser}
      durationInFrames={sec(18.1)}
      fps={FPS}
      {...V}
    />
  </>
);
