import { describe, expect, it } from 'vitest';

import { addressSegment, solanaPairsUrl, solanaTokenPairsUrl } from '@/lib/market/dexscreener';
import { dexPairsUrl, dexTokensUrl } from '@/lib/solana/creator';

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('DexScreener URLs', () => {
  it('keep Solana addresses as they are, case included', () => {
    expect(solanaTokenPairsUrl(JUP)).toBe(
      `https://api.dexscreener.com/token-pairs/v1/solana/${JUP}`,
    );
    expect(dexTokensUrl([JUP, BONK])).toBe(
      `https://api.dexscreener.com/tokens/v1/solana/${JUP},${BONK}`,
    );
    expect(addressSegment([JUP, BONK])).toBe(`${JUP},${BONK}`);
  });

  it('refuse anything that is not a Solana address, so a request cannot change the path or the host', () => {
    for (const bad of ['../../v1/x', 'evil.com/x', `${JUP}/../x`, `${JUP}?a=1`, '0x1234', '']) {
      expect(() => solanaTokenPairsUrl(bad)).toThrow();
      expect(() => solanaPairsUrl([bad])).toThrow();
      expect(() => dexTokensUrl([JUP, bad])).toThrow();
      expect(() => dexPairsUrl([bad])).toThrow();
    }
  });
});
