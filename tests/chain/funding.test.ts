import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountListUrl, findFirstFunding, firstIncoming } from '../../src/lib/chain/funding';

const WALLET = '0x00000000000000000000000000000000000000c1';

afterEach(() => vi.unstubAllGlobals());

describe('first funding', () => {
  it('asks Blockscout for the oldest entries first', () => {
    const url = new URL(accountListUrl('txlistinternal', WALLET, 'k'));
    expect(url.pathname).toBe('/4663/api');
    expect(url.searchParams.get('action')).toBe('txlistinternal');
    expect(url.searchParams.get('sort')).toBe('asc');
  });

  it('takes the first incoming transfer of value, skipping failures and zero values', () => {
    expect(
      firstIncoming(WALLET, [
        { to: '0xelse', from: '0x1', value: '5', blockNumber: '1', hash: '0xa' },
        { to: WALLET, from: '0x2', value: '0', blockNumber: '2', hash: '0xb' },
        { to: WALLET, from: '0x3', value: '9', blockNumber: '3', hash: '0xC', isError: '1' },
        { to: WALLET, from: '0xF4', value: '9', blockNumber: '4', hash: '0xD' },
      ]),
    ).toEqual({ funder: '0xf4', txHash: '0xd', block: 4 });
  });

  it('keeps the earlier of the normal and internal fundings', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      Response.json({
        status: '1',
        result: String(url).includes('txlistinternal')
          ? [{ to: WALLET, from: '0xbridge', value: '1', blockNumber: '5', transactionHash: '0xi' }]
          : [{ to: WALLET, from: '0xfriend', value: '1', blockNumber: '9', hash: '0xn' }],
      }),
    );
    expect(await findFirstFunding(WALLET, 'k')).toEqual({
      funder: '0xbridge',
      txHash: '0xi',
      block: 5,
    });
  });

  it('says none when the wallet never received value', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ status: '0', message: 'No transactions found', result: [] }),
    );
    expect(await findFirstFunding(WALLET, 'k')).toBeNull();
  });

  it('fails rather than answering none when Blockscout refuses', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ status: '0', message: 'NOTOK', result: 'Invalid API key' }),
    );
    await expect(findFirstFunding(WALLET, 'k')).rejects.toThrow(/Invalid API key/);
  });
});
