import { describe, expect, it } from 'vitest';
import { isSolanaAddress } from '../../src/lib/solana/address';
import { ext } from './ext';

const { fromUrl, fromLink, keyOf, siteOf, isAddress } = ext.detect;

/** pump.fun token "The Poor Bull" (REFERENCE.json, pump-creator-sold). */
const TOKEN = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';
/** The PumpSwap pool DexScreener lists for FIONA (REFERENCE.json, pump-graduated). */
const PAIR = 'DjbLtX1HRGZZrJgJ7CwTX6SN3D7tBLiytkGwomBUwTVB';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** A transaction signature: 64 bytes, never an address. */
const TX =
  '5j7s1QzqC9kXcVnZ3wHhLKXqJ9x7GdSxF2X8b4T5dYhN8vQe2aZkKcV3pR1mWnYtUo6sLqPa9rDf4GhJk2LmNbVc';

/** A stand-in for an <a> element: enough for the detector. */
function anchor(href: string, parent: Record<string, unknown> | null = null) {
  return {
    tagName: 'A',
    isContentEditable: false,
    parentElement: parent,
    getAttribute: (name: string) => (name === 'href' ? href : null),
  };
}

describe('Solana addresses', () => {
  it.each([TOKEN, PAIR, USDC, 'So11111111111111111111111111111111111111112', '1'.repeat(32)])(
    'agrees with the server on %s',
    (address) => {
      expect(isAddress(address)).toBe(true);
      expect(isSolanaAddress(address)).toBe(true);
    },
  );

  it.each([
    TX,
    '0x10e848f9d5073d670201b111f1ba3d1c5be6f18b',
    `${TOKEN.slice(0, -1)}0`,
    'z'.repeat(44),
    'abc',
    '',
  ])('refuses %s', (value) => {
    expect(isAddress(value)).toBe(false);
    expect(isSolanaAddress(value)).toBe(false);
  });
});

describe('token pages, from the URL', () => {
  it('reads a DexScreener Solana pair', () => {
    expect(fromUrl(`https://dexscreener.com/solana/${PAIR}`)).toEqual({
      kind: 'pair',
      address: PAIR,
    });
    expect(fromUrl(`https://dexscreener.com/solana/${PAIR}?maker=1`)?.address).toBe(PAIR);
  });

  it('reads Solscan, the Solana Explorer and pump.fun token pages, case kept', () => {
    expect(fromUrl(`https://solscan.io/token/${USDC}`)).toEqual({ kind: 'token', address: USDC });
    expect(fromUrl(`https://solscan.io/token/${USDC}#holders`)?.address).toBe(USDC);
    expect(fromUrl(`https://explorer.solana.com/address/${USDC}`)).toEqual({
      kind: 'token',
      address: USDC,
    });
    expect(fromUrl(`https://explorer.solana.com/address/${USDC}/largest`)?.address).toBe(USDC);
    expect(fromUrl(`https://pump.fun/coin/${TOKEN}`)).toEqual({ kind: 'token', address: TOKEN });
    expect(fromUrl(`https://www.pump.fun/coin/${TOKEN}/`)?.kind).toBe('token');
  });

  it('never lower-cases an address: base58 is case-sensitive', () => {
    const query = fromUrl(`https://solscan.io/token/${USDC}`);
    expect(query?.address).toBe(USDC);
    expect(query?.address).not.toBe(USDC.toLowerCase());
    // The lower-cased string is another address, or none: never the token's.
    expect(fromUrl(`https://solscan.io/token/${USDC.toLowerCase()}`)?.address).not.toBe(USDC);
  });

  it('reads mainnet only', () => {
    expect(fromUrl(`https://explorer.solana.com/address/${USDC}?cluster=devnet`)).toBeNull();
    expect(fromUrl(`https://solscan.io/token/${USDC}?cluster=testnet`)).toBeNull();
    expect(
      fromUrl(`https://explorer.solana.com/address/${USDC}?cluster=mainnet-beta`)?.address,
    ).toBe(USDC);
  });

  it('ignores other chains, other pages and other sites', () => {
    expect(fromUrl(`https://dexscreener.com/ethereum/${PAIR}`)).toBeNull();
    expect(fromUrl('https://dexscreener.com/solana')).toBeNull();
    expect(fromUrl(`https://solscan.io/account/${USDC}`)).toBeNull();
    expect(fromUrl(`https://pump.fun/profile/${TOKEN}`)).toBeNull();
    expect(fromUrl(`https://example.com/token/${USDC}`)).toBeNull();
    expect(fromUrl(`https://dexscreener.com.evil.example/solana/${PAIR}`)).toBeNull();
    expect(fromUrl('not a url')).toBeNull();
    expect(fromUrl(`javascript:alert(1)//solana/${PAIR}`)).toBeNull();
  });

  it('never takes a transaction signature for a token', () => {
    expect(fromUrl(`https://explorer.solana.com/tx/${TX}`)).toBeNull();
    expect(fromUrl(`https://solscan.io/tx/${TX}`)).toBeNull();
    expect(fromUrl(`https://solscan.io/token/${TX}`)).toBeNull();
    expect(fromUrl(`https://pump.fun/coin/${TX}`)).toBeNull();
    // A longer base58 string behind the address: not an address page.
    expect(fromUrl(`https://dexscreener.com/solana/${PAIR}ab`)).toBeNull();
  });
});

describe('links to token pages', () => {
  const page = 'https://solscan.io/tokens';

  it('resolves relative links against the page', () => {
    expect(fromLink(anchor(`/token/${USDC}`), page)).toEqual({ kind: 'token', address: USDC });
    expect(fromLink(anchor(`/coin/${TOKEN}`), 'https://pump.fun/board')).toEqual({
      kind: 'token',
      address: TOKEN,
    });
  });

  it('follows links from one supported site to another', () => {
    expect(fromLink(anchor(`https://dexscreener.com/solana/${PAIR}`), page)).toEqual({
      kind: 'pair',
      address: PAIR,
    });
  });

  it('skips transaction, account and anchor-only links', () => {
    expect(fromLink(anchor(`/tx/${TX}`), page)).toBeNull();
    expect(fromLink(anchor(`/account/${USDC}`), page)).toBeNull();
    expect(fromLink(anchor('#'), page)).toBeNull();
    expect(fromLink(anchor(''), page)).toBeNull();
    expect(fromLink(null, page)).toBeNull();
  });

  it('never acts on a link inside a field or editable text', () => {
    const editor = { tagName: 'DIV', isContentEditable: true, parentElement: null };
    expect(fromLink(anchor(`/token/${USDC}`, editor), page)).toBeNull();
  });
});

describe('keys and sites', () => {
  it('gives one key per token, in its own case', () => {
    expect(keyOf({ kind: 'token', address: TOKEN })).toBe(`token:${TOKEN}`);
    expect(keyOf({ kind: 'token', address: USDC })).not.toBe(
      keyOf({ kind: 'token', address: USDC.toLowerCase() }),
    );
  });

  it('stores a site without its www', () => {
    expect(siteOf('www.pump.fun')).toBe('pump.fun');
    expect(siteOf('DexScreener.com')).toBe('dexscreener.com');
  });

  it('names every site the manifest runs on', () => {
    const hosts = ext.config.SITES.map((s) => s.host);
    expect(hosts).toEqual(['dexscreener.com', 'solscan.io', 'explorer.solana.com', 'pump.fun']);
  });
});
