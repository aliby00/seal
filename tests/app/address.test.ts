import { describe, expect, it } from 'vitest';
import {
  ADDRESS_HINT,
  addressHint,
  EXAMPLES,
  EXAMPLE_TOKEN,
  isTokenAddress,
  PAIR_HINT,
  pairFromInput,
  resolveInput,
} from '../../src/app/components/analyze-request';
import { addressUrl, marketUrl, short, txUrl } from '../../src/app/components/explorer';
import { isSolanaAddress } from '../../src/lib/solana/address';

describe('the address field', () => {
  it.each([
    'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'So11111111111111111111111111111111111111112',
    '11111111111111111111111111111111',
  ])('takes a Solana address: %s', (address) => {
    expect(isTokenAddress(address)).toBe(true);
  });

  it.each([
    ['an EVM address', '0x10e848f9d5073d670201b111f1ba3d1c5be6f18b'],
    ['a character outside base58', 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5N0ump'],
    ['too short', 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8'],
    ['too long for 32 bytes', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    [
      'a transaction signature',
      '5j7s1QzqC9kXcVnZ3wHhLKXqJ9x7GdSxF2X8b4T5dYhN8vQe2aZkKcV3pR1mWnYtUo6sLqPa9rDf4GhJk2LmNbVc',
    ],
    ['empty', ''],
  ])('refuses %s', (_what, value) => {
    expect(isTokenAddress(value)).toBe(false);
  });

  it('says SEAL now reads Solana when the address pasted is an EVM one', () => {
    // PEPE on Ethereum, as pasted during the audit of 25/11/2026.
    for (const evm of [
      '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
      ' 0x10e848f9d5073d670201b111f1ba3d1c5be6f18b ',
    ]) {
      expect(addressHint(evm)).toBe(
        'SEAL now reads Solana tokens. This looks like an EVM address (0x…): paste the token’s Solana address instead.',
      );
    }
    for (const other of ['bonjour', '0x1234', 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8', '']) {
      expect(addressHint(other)).toBe(ADDRESS_HINT);
    }
  });

  it('agrees with the server’s own check on every example', () => {
    for (const example of EXAMPLES) {
      expect(isTokenAddress(example.token)).toBe(true);
      expect(isSolanaAddress(example.token)).toBe(true);
    }
    expect(EXAMPLE_TOKEN).toBe(EXAMPLES[0]!.token);
    expect(new Set(EXAMPLES.map((e) => e.token)).size).toBe(3);
  });
});

describe('explorer links', () => {
  const MINT = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';

  it('link to the Solana Explorer and DexScreener with the address as given', () => {
    expect(addressUrl(MINT)).toBe(`https://explorer.solana.com/address/${MINT}`);
    expect(txUrl('5Rftux22abc')).toBe('https://explorer.solana.com/tx/5Rftux22abc');
    expect(marketUrl(MINT)).toBe(`https://dexscreener.com/solana/${MINT}`);
  });

  it('shortens base58 as the explorers do, case kept', () => {
    expect(short(MINT)).toBe('FB5e…pump');
    expect(short('So11111111111111111111111111111111111111112')).toBe('So11…1112');
    expect(short('abc')).toBe('abc');
  });
});

describe('a pasted pair link', () => {
  const MINT = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';
  const PAIR = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
  const answer = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it('names the pool of a DexScreener or Photon link, and nothing else', () => {
    expect(pairFromInput(`https://dexscreener.com/solana/${PAIR}`)).toBe(PAIR);
    expect(pairFromInput(`dexscreener.com/solana/${PAIR}?maker=x`)).toBe(PAIR);
    expect(pairFromInput(`https://photon-sol.tinyastro.io/en/lp/${PAIR}?handle=1`)).toBe(PAIR);
    expect(pairFromInput(`https://pump.fun/coin/${MINT}`)).toBeNull();
    expect(pairFromInput(MINT)).toBeNull();
    expect(pairFromInput('https://dexscreener.com/base/0x1234')).toBeNull();
  });

  it('resolves a pair to the token its pool trades', async () => {
    const fetcher = answer({ pairs: [{ baseToken: { address: MINT } }] });
    expect(await resolveInput(`https://dexscreener.com/solana/${PAIR}`, fetcher)).toBe(MINT);
    expect(await resolveInput(`https://photon-sol.tinyastro.io/en/lp/${PAIR}`, fetcher)).toBe(MINT);
  });

  it('keeps the address when DexScreener knows no pair there (a link to the token itself)', async () => {
    expect(
      await resolveInput(`https://dexscreener.com/solana/${MINT}`, answer({ pairs: null })),
    ).toBe(MINT);
  });

  it('says it is a pair when the lookup fails', async () => {
    expect(await resolveInput(`https://dexscreener.com/solana/${PAIR}`, answer({}, false))).toBe(
      null,
    );
    const broken = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await resolveInput(`https://dexscreener.com/solana/${PAIR}`, broken)).toBeNull();
    expect(addressHint(`https://photon-sol.tinyastro.io/en/lp/${PAIR}`)).toBe(PAIR_HINT);
  });

  it('leaves every other link to the plain extraction, without a lookup', async () => {
    const never = (async () => {
      throw new Error('no lookup expected');
    }) as unknown as typeof fetch;
    expect(await resolveInput(`https://solscan.io/token/${MINT}`, never)).toBe(MINT);
  });
});
