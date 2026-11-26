import { describe, expect, it, vi } from 'vitest';
import type { TokenReport } from '../../src/lib/contracts';
import { offlineExplanation } from '../../src/lib/agent/offline';
import { explain } from '../../src/lib/agent/reason';
import { findViolations } from '../../src/lib/agent/guardrails';
import { CREATOR, HOLDER, solanaReport } from '../helpers/solana-report';

const AT = '2026-11-25T00:00:00.000Z';
const base = solanaReport();

/** The text's blocks, as the page splits them. */
const blocks = (text: string) => text.split(/\n{2,}/);

describe('offlineExplanation', () => {
  const report = solanaReport();
  const text = offlineExplanation(report);

  it('has the shape of the reading: what stands out, then what is clean', () => {
    const b = blocks(text);
    expect(b[0]).toBe('What stands out');
    expect(b[1]!.length).toBeGreaterThan(20);
    // No pipeline talk: the reader is a trader, not the one who built it.
    expect(text).not.toMatch(/reasoning agent|cross-examin|This account|in the first 1 seconds/);
  });

  it("respecte les mêmes garde-fous que l'agent", () => {
    expect(findViolations(text)).toEqual([]);
  });

  it('stays short: a trader reads it in ten seconds', () => {
    expect(text.split(/\s+/).length).toBeLessThan(190);
  });

  it('says the dev sold when its moves show a sale, in trader words', () => {
    const sold = solanaReport({
      creatorOnToken: base.creatorOnToken && {
        ...base.creatorOnToken,
        data: {
          ...base.creatorOnToken.data,
          bought: '30000000000000',
          sold: '30000000000000',
          solSpent: '1290000000',
          holdsNow: '0',
          saleSize: 'material',
        },
      },
    });
    const out = offlineExplanation(sold);
    expect(out).toMatch(/The dev bought 3\.0% of the supply for 1\.29 SOL/);
    expect(out).toMatch(/sold all of it/);
    expect(out).toMatch(/it holds none of it today/);
  });

  it('never says "has not sold" when not every move was read', () => {
    const partial = solanaReport({
      creatorOnToken: base.creatorOnToken && {
        ...base.creatorOnToken,
        completeness: 'partial',
        data: {
          ...base.creatorOnToken.data,
          bought: '30000000000000',
          transactions: { listed: 16, read: 15 },
        },
      },
    });
    const out = offlineExplanation(partial);
    expect(out).not.toMatch(/has not sold|did not sell/);
  });

  it('a power someone still holds over holders comes first', () => {
    const held = solanaReport({
      powers: [
        {
          power: 'freeze',
          status: 'held',
          holder: CREATOR,
          sentence:
            "Someone can freeze any holder's tokens so they cannot be moved (freeze authority).",
          from: 'mint',
        },
      ],
    });
    const out = offlineExplanation(held);
    expect(blocks(out)[1]).toMatch(/^(?:The creator|Someone) can still freeze any holder’s tokens/);
  });

  it('names a bundle with its number, and what the wallets hold today', () => {
    const grouped = solanaReport({
      launch: {
        ...base.launch,
        data: {
          ...base.launch.data,
          sameSlot: {
            wallets: 3,
            share: 0.419,
            transactions: 2,
            heldNow: 0,
            unread: 0,
            soldInWindow: 3,
            solSpent: 24.2,
            addresses: [],
          },
        },
      },
    });
    expect(offlineExplanation(grouped)).toContain(
      'Bundled launch: 3 wallets other than the dev took 41.9% of the supply in the creation slot',
    );
  });

  it('one wallet in the creation slot is no bundle', () => {
    const one = solanaReport({
      launch: {
        ...base.launch,
        data: {
          ...base.launch.data,
          sameSlot: {
            wallets: 1,
            share: 0.025,
            transactions: 1,
            heldNow: 0,
            unread: 0,
            soldInWindow: 1,
            solSpent: 2.9,
            addresses: [],
          },
        },
      },
    });
    expect(offlineExplanation(one)).not.toMatch(/[Bb]undle/);
  });

  it('says what the wallets the dev funded did, without saying who controls them', () => {
    const funded = solanaReport({
      linkedWallets: base.linkedWallets && {
        ...base.linkedWallets,
        data: {
          ...base.linkedWallets.data,
          window: { from: 1795552000, to: 1795560000 },
          funded: [
            {
              wallet: HOLDER,
              transfers: [],
              lamports: '1000000000',
              onToken: {
                bought: '40000000000000',
                sold: '30000000000000',
                holdsNow: '0',
                sales: [],
                complete: true,
              },
            },
          ],
        },
      },
    });
    expect(offlineExplanation(funded)).toContain(
      '1 wallet the dev sent SOL to around the launch bought 4.0% of the supply; a transfer links them, it does not show who controls them.',
    );
  });

  it('says nothing names a dev, rather than "could not be read"', () => {
    const none = solanaReport({
      creator: { ...base.creator, data: { ...base.creator.data, creator: null, from: null } },
      creatorHistory: null,
      creatorOnToken: null,
      linkedWallets: null,
    });
    expect(offlineExplanation(none)).toMatch(
      /No curve, creation transaction or metadata authority names a dev\./,
    );
  });

  it('says when who holds it could not be read', () => {
    const missing = solanaReport({
      holders: {
        ...base.holders,
        completeness: 'unavailable',
        sources: [
          { name: 'solana-rpc', fetchedAt: AT, note: 'too many token accounts to read them all' },
        ],
      },
    });
    expect(offlineExplanation(missing)).toMatch(/Who holds it could not be read\./);
  });

  it('says a failed read once, in the last line', () => {
    const failed: TokenReport = {
      ...report,
      completeness: 'partial',
      failedReads: [{ read: 'holders', note: 'rate-limit : solana-rpc : request limit reached' }],
    };
    const out = offlineExplanation(failed);
    expect(blocks(out).at(-1)).toMatch(/^Not read this time: who holds it\./);
    expect(out.match(/who holds it/g)).toHaveLength(1);
    expect(out).not.toMatch(/Partial report|The report is partial/);
  });
});

describe('explain sans aucune clé', () => {
  it('bascule en hors-ligne au lieu de lever', async () => {
    vi.stubEnv('GROQ_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('AGENT_PROVIDER', '');
    const result = await explain(solanaReport());
    expect(result.offline).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    vi.unstubAllEnvs();
  });
});
