import { describe, expect, it } from 'vitest';
import { whereSetAside } from '../../src/lib/set-aside';

describe('whereSetAside', () => {
  it('names what was found set aside', () => {
    expect(whereSetAside([{ role: 'curve', share: 0.8 }])).toBe('its bonding curve');
    expect(
      whereSetAside([
        { role: 'pool', share: 0.1 },
        { role: 'vesting', share: 0.2 },
      ]),
    ).toBe('its trading pools and locks');
  });

  it('gives a token with nothing set aside no curve of its own', () => {
    // USDC's card, 25/11/2026: "held outside its curve and pools", for a token with no curve.
    expect(whereSetAside([])).toBe('any curve, pool or lock');
    expect(whereSetAside(undefined)).not.toMatch(/\bits curve\b/);
  });
});
