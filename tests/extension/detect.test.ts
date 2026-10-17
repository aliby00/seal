import { describe, expect, it } from 'vitest';
import { ext } from './ext';

const { fromUrl, fromLink, keyOf, siteOf } = ext.detect;

const TOKEN = '0x10e848f9d5073d670201b111f1ba3d1c5be6f18b';
const PAIR_V3 = '0xfad2403a6d394803bdd4c008c3cecc9be7d40989';
const POOL_V4 = '0x7f8271c1a7a6a434f33b0babc15bf2980a0dcb4196848b4f7e789a7fd73a5350';
const TX = `0x${'ab'.repeat(32)}`;

/** A stand-in for an <a> element: enough for the detector. */
function anchor(href: string, parent: Record<string, unknown> | null = null) {
  return {
    tagName: 'A',
    isContentEditable: false,
    parentElement: parent,
    getAttribute: (name: string) => (name === 'href' ? href : null),
  };
}

describe('token pages, from the URL', () => {
  it('reads a DexScreener Robinhood pair, pool or v4 pool id', () => {
    expect(fromUrl(`https://dexscreener.com/robinhood/${PAIR_V3}`)).toEqual({
      kind: 'pair',
      address: PAIR_V3,
    });
    expect(fromUrl(`https://dexscreener.com/robinhood/${POOL_V4}?maker=1`)).toEqual({
      kind: 'pair',
      address: POOL_V4,
    });
  });

  it('reads Blockscout and pons token pages, whatever the case of the address', () => {
    expect(
      fromUrl(
        `https://robinhoodchain.blockscout.com/token/${TOKEN.toUpperCase().replace('0X', '0x')}`,
      ),
    ).toEqual({ kind: 'token', address: TOKEN });
    expect(fromUrl(`https://robinhoodchain.blockscout.com/token/${TOKEN}/holders#top`)).toEqual({
      kind: 'token',
      address: TOKEN,
    });
    expect(fromUrl(`https://www.ponsfamily.com/launchpad/${TOKEN}`)).toEqual({
      kind: 'token',
      address: TOKEN,
    });
    expect(fromUrl(`https://ponsfamily.com/launchpad/${TOKEN}/`)?.kind).toBe('token');
  });

  it('ignores other chains, other pages and other sites', () => {
    expect(fromUrl(`https://dexscreener.com/ethereum/${PAIR_V3}`)).toBeNull();
    expect(fromUrl('https://dexscreener.com/robinhood')).toBeNull();
    expect(fromUrl(`https://robinhoodchain.blockscout.com/address/${TOKEN}`)).toBeNull();
    expect(fromUrl(`https://example.com/token/${TOKEN}`)).toBeNull();
    expect(fromUrl(`https://dexscreener.com.evil.example/robinhood/${PAIR_V3}`)).toBeNull();
    expect(fromUrl('not a url')).toBeNull();
    expect(fromUrl(`javascript:alert(1)//robinhood/${TOKEN}`)).toBeNull();
  });

  it('never takes a transaction hash for a token', () => {
    expect(fromUrl(`https://robinhoodchain.blockscout.com/tx/${TX}`)).toBeNull();
    expect(fromUrl(`https://robinhoodchain.blockscout.com/token/${TX}`)).toBeNull();
    expect(fromUrl(`https://ponsfamily.com/launchpad/${TX}`)).toBeNull();
    // 41 to 63 characters: neither an address nor a pool id.
    expect(fromUrl(`https://dexscreener.com/robinhood/${TOKEN}ab`)).toBeNull();
  });
});

describe('links to token pages', () => {
  const page = 'https://robinhoodchain.blockscout.com/tokens';

  it('resolves relative links against the page', () => {
    expect(fromLink(anchor(`/token/${TOKEN}`), page)).toEqual({ kind: 'token', address: TOKEN });
    expect(fromLink(anchor(`/launchpad/${TOKEN}`), 'https://www.ponsfamily.com/launchpad')).toEqual(
      { kind: 'token', address: TOKEN },
    );
  });

  it('follows links from one supported site to another', () => {
    expect(fromLink(anchor(`https://dexscreener.com/robinhood/${PAIR_V3}`), page)).toEqual({
      kind: 'pair',
      address: PAIR_V3,
    });
  });

  it('skips transaction, address and anchor-only links', () => {
    expect(fromLink(anchor(`/tx/${TX}`), page)).toBeNull();
    expect(fromLink(anchor(`/address/${TOKEN}`), page)).toBeNull();
    expect(fromLink(anchor('#'), page)).toBeNull();
    expect(fromLink(anchor(''), page)).toBeNull();
    expect(fromLink(null, page)).toBeNull();
  });

  it('never acts on a link inside a field or editable text', () => {
    const editor = { tagName: 'DIV', isContentEditable: true, parentElement: null };
    expect(fromLink(anchor(`/token/${TOKEN}`, editor), page)).toBeNull();
  });
});

describe('keys and sites', () => {
  it('gives one key per token, whatever the case', () => {
    expect(keyOf({ kind: 'token', address: TOKEN.toUpperCase() })).toBe(`token:${TOKEN}`);
  });

  it('stores a site without its www', () => {
    expect(siteOf('www.ponsfamily.com')).toBe('ponsfamily.com');
    expect(siteOf('DexScreener.com')).toBe('dexscreener.com');
  });
});
