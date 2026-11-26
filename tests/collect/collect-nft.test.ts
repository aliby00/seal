import { describe, expect, it } from 'vitest';
import { isNftMint } from '../../src/lib/collect';

// FCXErX… (prod audit, 26/11/2026): an NFT read as a token, its one holder
// "holding 100% of the tokens". SEAL reads fungible tokens.
describe('isNftMint', () => {
  it('tells an NFT mint: no decimals, a supply of one', () => {
    expect(isNftMint({ decimals: 0, supply: '1' })).toBe(true);
  });

  it('leaves every fungible token alone, whole-unit ones included', () => {
    expect(isNftMint({ decimals: 6, supply: '1' })).toBe(false);
    expect(isNftMint({ decimals: 0, supply: '1000000' })).toBe(false);
    expect(isNftMint({ decimals: 0, supply: '0' })).toBe(false);
    expect(isNftMint({ decimals: null, supply: null })).toBe(false);
    expect(isNftMint(null)).toBe(false);
  });
});
