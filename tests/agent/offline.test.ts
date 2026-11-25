import { describe, expect, it, vi } from 'vitest';
import type { TokenReport } from '../../src/lib/contracts';
import { offlineExplanation } from '../../src/lib/agent/offline';
import { explain } from '../../src/lib/agent/reason';
import { findViolations } from '../../src/lib/agent/guardrails';
import { CREATOR, HOLDER, solanaReport } from '../helpers/solana-report';

const AT = '2026-11-25T00:00:00.000Z';
const base = solanaReport();

describe('offlineExplanation', () => {
  const report = solanaReport();
  const text = offlineExplanation(report);

  it("annonce d'emblée qu'elle ne croise pas les signaux", () => {
    expect(text.split('\n')[0]).toMatch(/without the reasoning agent/);
  });

  it("respecte les mêmes garde-fous que l'agent", () => {
    expect(findViolations(text)).toEqual([]);
  });

  it('names the creator, where it was read, and what it did with this token', () => {
    expect(text).toContain(`Creator: ${CREATOR.slice(0, 4)}…${CREATOR.slice(-4)}`);
    expect(text).toContain('named by its pump.fun bonding curve');
    // Every move was read, and there was none: no sale is a fact here.
    expect(text).toMatch(/The creator has no move on this token: it did not sell any\./);
  });

  it('says the creator sold when its moves show a sale', () => {
    const sold = solanaReport({
      creatorOnToken: base.creatorOnToken && {
        ...base.creatorOnToken,
        data: { ...base.creatorOnToken.data, sold: '5000' },
      },
    });
    expect(offlineExplanation(sold)).toMatch(/the creator sold <0\.01% of the supply/);
  });

  it('never says "did not sell" when not every move was read', () => {
    const partial = solanaReport({
      creatorOnToken: base.creatorOnToken && {
        ...base.creatorOnToken,
        completeness: 'partial',
        data: { ...base.creatorOnToken.data, transactions: { listed: 16, read: 15 } },
      },
    });
    const out = offlineExplanation(partial);
    expect(out).toMatch(/No sale by the creator was seen in the 15 of 16 transactions read/);
    expect(out).not.toMatch(/did not sell/);
  });

  it('says what the mint lets someone do, and who holds it', () => {
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
        {
          power: 'mint',
          status: 'none',
          holder: null,
          sentence: 'No one can create new tokens.',
          from: 'mint',
        },
      ],
    });
    expect(offlineExplanation(held)).toContain(
      `Mint (Token-2022): No one can create new tokens. Someone can freeze any holder's tokens so they cannot be moved (freeze authority). Held by ${CREATOR.slice(0, 4)}…${CREATOR.slice(-4)}, the creator.`,
    );
    expect(text).toContain('Mint (Token-2022): No one can create new tokens.');
  });

  it('says what wallets got together at launch, and what they hold today', () => {
    const grouped = solanaReport({
      launch: {
        ...base.launch,
        data: {
          ...base.launch.data,
          sameSlot: {
            wallets: 2,
            share: 0.395,
            transactions: 2,
            heldNow: 0,
            unread: 0,
            soldInWindow: 0,
            solSpent: 24.2,
            addresses: [],
          },
        },
      },
    });
    expect(offlineExplanation(grouped)).toContain(
      'Launch: in the creation slot, 2 wallets other than the creator got 39.5 % of the supply and hold none of it today.',
    );
  });

  it('says what the wallets the creator funded did, without saying who controls them', () => {
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
    const out = offlineExplanation(funded);
    expect(out).toContain(
      'Around the launch it sent SOL to 1 wallet; 1 of them traded this token, selling 3.0% of the supply. A transfer links the addresses; it does not show who controls them.',
    );
  });

  it('says nothing names a creator, rather than "could not be read"', () => {
    const none = solanaReport({
      creator: { ...base.creator, data: { ...base.creator.data, creator: null, from: null } },
      creatorHistory: null,
      creatorOnToken: null,
      linkedWallets: null,
    });
    expect(offlineExplanation(none)).toMatch(
      /no curve, creation transaction or metadata authority/,
    );
  });

  it("dit pourquoi une source manque au lieu de l'omettre", () => {
    const missing = solanaReport({
      holders: {
        ...base.holders,
        completeness: 'unavailable',
        sources: [
          { name: 'solana-rpc', fetchedAt: AT, note: 'too many token accounts to read them all' },
        ],
      },
    });
    expect(offlineExplanation(missing)).toMatch(/Holder concentration: not measured/);
  });

  it("donne le volume rapporté au nombre d'échanges", () => {
    expect(text).toMatch(/across 70 trades/);
  });

  it('says where the market figures were read: the main pair, or the pairs added up', () => {
    expect(text).toContain('Over 24 hours on its main pair: ');
    const summed = solanaReport({
      market: {
        ...base.market,
        data: { ...base.market.data, pairsCounted: 28, quiet: { hours: 1 } },
      },
    });
    const said = offlineExplanation(summed);
    expect(said).toContain('Over 24 hours on 28 of its listed pairs: ');
    expect(said).toContain('no trade on any of its listed pairs in the last hour');
    expect(findViolations(said)).toEqual([]);
    // A report from before the pairs were added up: its figures are the main pair's.
    const older = solanaReport({
      market: { ...base.market, data: { ...base.market.data, quiet: { hours: 3 } } },
    });
    expect(offlineExplanation(older)).toContain('no trade on its main pair in the last 3 hours');
  });

  it('says a failed read once, at the top', () => {
    const failed: TokenReport = {
      ...report,
      completeness: 'partial',
      failedReads: [{ read: 'holders', note: 'rate-limit : solana-rpc : request limit reached' }],
    };
    const out = offlineExplanation(failed);
    expect(out).toMatch(/Partial report: some reads failed this time \(who holds it\)/);
    expect(out).not.toMatch(/Some reads cover only part of the data/);
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
