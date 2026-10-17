import type { GlanceData } from './ext';

/** A glance as /api/glance returns it. */
export const SAMPLE: GlanceData = {
  token: '0x10E848F9d5073D670201b111f1ba3D1C5bE6f18B',
  name: 'Alpha Token',
  symbol: 'ALP',
  url: 'https://sealauth.dev/?token=0x10E848F9d5073D670201b111f1ba3D1C5bE6f18B#analysis',
  collectedAt: '2026-10-01T00:00:00.000Z',
  glance: {
    headline: 'The creator sold into the pool on 7 of 10 launches checked.',
    items: [
      {
        id: 'sales',
        tone: 'attention',
        figure: '7/10',
        title: 'The creator sold into the pool on 7 of 10 launches checked.',
        detail: 'Sales found in each launch’s first days, confirmed by a trade in the pool.',
        href: '#fact-creator',
      },
      {
        id: 'record',
        tone: 'neutral',
        figure: '76',
        title: 'This creator launched 76 tokens in 12 days.',
        detail: 'Their launch record on chain, this token included.',
        href: '#fact-creator',
      },
      {
        id: 'supply',
        tone: 'neutral',
        figure: '31%',
        title: 'One wallet holds 31% of the tokens held outside the pool.',
        detail: 'The largest holder, pools and burn addresses left out.',
        href: '#fact-holders',
      },
      {
        id: 'liquidity',
        tone: 'reassuring',
        figure: '0/8',
        title: 'The launch liquidity was never withdrawn on the 8 launches checked.',
        detail: 'Withdrawals from each launch’s own liquidity position.',
        href: '#fact-creator',
      },
    ],
    unseen: ['live trading on an open market'],
  },
};
