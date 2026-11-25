import { describe, expect, it } from 'vitest';
import type { TokenReport } from '../../src/lib/contracts';
import { findClaims, forbiddenClaims, withoutClaims } from '../../src/lib/agent/claims';
import { CREATOR, HOLDER, solanaReport } from '../helpers/solana-report';

const base = solanaReport();
const kinds = (text: string, report: TokenReport) => findClaims(text, report).map((c) => c.kind);

describe('claims the Solana facts forbid', () => {
  it('cuts a power denied while the data says someone holds it', () => {
    const held = solanaReport({
      powers: [
        {
          power: 'freeze',
          status: 'held',
          holder: CREATOR,
          sentence: 'Someone can freeze.',
          from: 'mint',
        },
        { power: 'mint', status: 'none', holder: null, sentence: 'No one can mint.', from: 'mint' },
      ],
    });
    expect(kinds('The freeze authority has been revoked.', held)).toEqual(['power-denied']);
    expect(kinds('No one can freeze holders’ tokens.', held)).toEqual(['power-denied']);
    // What the data says nobody holds may be said.
    expect(kinds('No one can mint more tokens.', held)).toEqual([]);
    expect(kinds('No one can freeze holders’ tokens.', base)).toEqual([]);
  });

  it('cuts any denied power when the mint itself was not read', () => {
    const unread = solanaReport({
      mint: { ...base.mint, completeness: 'unavailable', data: null },
      powers: [],
    });
    expect(kinds('The supply is fixed supply with no mint authority left.', unread)).toEqual([
      'power-denied',
    ]);
  });

  it('cuts "immutable" said of the token, and keeps it said of metadata nobody can change', () => {
    expect(kinds('The token is immutable.', base)).toEqual(['immutable']);
    expect(kinds('Its name and symbol cannot be changed.', base)).toEqual([]);
    const mutable = solanaReport({
      mint: {
        ...base.mint,
        data: { ...base.mint.data!, metadata: { ...base.mint.data!.metadata!, isMutable: true } },
      },
    });
    expect(kinds('Its name and symbol cannot be changed.', mutable)).toEqual(['immutable']);
  });

  it('cuts "no link" when wallets the creator funded traded the token', () => {
    const linked = solanaReport({
      linkedWallets: {
        ...base.linkedWallets!,
        data: {
          ...base.linkedWallets!.data,
          funded: [
            {
              wallet: HOLDER,
              transfers: [],
              lamports: '1',
              onToken: { bought: '10', sold: '0', holdsNow: '10', sales: [], complete: true },
            },
          ],
        },
      },
    });
    expect(forbiddenClaims(linked).has('no-link')).toBe(true);
    expect(kinds('There is no link between the creator and the holders.', linked)).toEqual([
      'no-link',
    ]);
    expect(forbiddenClaims(base).has('no-link')).toBe(false);
  });

  it('cuts "no link" when wallets got tokens in transactions the creator paid for', () => {
    const paid = solanaReport({
      launch: {
        ...base.launch,
        data: {
          ...base.launch.data,
          payerGroup: {
            wallets: 4,
            share: 0.12,
            transactions: 4,
            heldNow: 0,
            unread: 0,
            soldInWindow: 0,
            solSpent: 3,
            addresses: [],
            payers: [CREATOR],
          },
        },
      },
    });
    expect(kinds('The holders are not linked to the creator.', paid)).toEqual(['no-link']);
  });

  it('cuts a count of creation-slot wallets the data gives otherwise', () => {
    const slot = solanaReport({
      launch: {
        ...base.launch,
        data: {
          ...base.launch.data,
          sameSlot: {
            wallets: 3,
            share: 0.25,
            transactions: 3,
            heldNow: 0,
            unread: 0,
            soldInWindow: 0,
            solSpent: 3,
            addresses: [],
          },
        },
      },
    });
    expect(kinds('Two wallets bought in the creation slot.', slot)).toEqual(['count']);
    expect(kinds('Three wallets got a quarter of the supply in the creation slot.', slot)).toEqual(
      [],
    );
  });

  it('cuts "did not sell" when the creator sold, and an absence a failed read would have settled', () => {
    const sold = solanaReport({
      creatorOnToken: {
        ...base.creatorOnToken!,
        data: { ...base.creatorOnToken!.data, sold: '5' },
      },
    });
    expect(kinds('The creator did not sell.', sold)).toEqual(['no-sale']);
    expect(kinds('The creator’s record is clean.', sold)).toEqual(['clean-record']);
    const failed = solanaReport({
      failedReads: [
        { read: 'linked-wallets', note: 'rate-limit : solana-rpc : request limit reached' },
      ],
    });
    expect(kinds('The creator did not fund other wallets.', failed)).toEqual(['unread']);
    expect(kinds('Whether it funded other wallets could not be read.', failed)).toEqual([]);
  });

  it('never lets the creator’s first token be claimed', () => {
    expect(kinds('This is the creator’s first token.', base)).toEqual(['only-token']);
    expect(kinds('No other launch was found on pump.fun’s curves.', base)).toEqual([]);
  });

  it('serves the text without the sentences it cut, the rest kept', () => {
    const held = solanaReport({
      powers: [
        {
          power: 'mint',
          status: 'held',
          holder: CREATOR,
          sentence: 'Someone can mint.',
          from: 'mint',
        },
      ],
    });
    const { text, dropped } = withoutClaims(
      'What deserves attention\n\nThe mint authority is renounced. The creator can create new tokens.',
      held,
    );
    expect(dropped.map((d) => d.kind)).toEqual(['power-denied']);
    expect(text).toBe('What deserves attention\n\nThe creator can create new tokens.');
  });
});
