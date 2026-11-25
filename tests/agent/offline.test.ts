import { describe, expect, it, vi } from 'vitest';
import type { TokenReport } from '../../src/lib/contracts';
import { offlineExplanation } from '../../src/lib/agent/offline';
import { explain } from '../../src/lib/agent/reason';
import { findViolations } from '../../src/lib/agent/guardrails';
import { CREATOR, solanaReport } from '../helpers/solana-report';

// TODO-SOLANA: the offline wording is a stand-in until the agent is
// rewritten on the Solana report; these tests hold what it must keep.
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
    expect(text).toMatch(/did not sell this token/);
  });

  it('says the creator sold when its moves show a sale', () => {
    const sold = solanaReport({
      creatorOnToken: base.creatorOnToken && {
        ...base.creatorOnToken,
        data: { ...base.creatorOnToken.data, sold: '5000' },
      },
    });
    expect(offlineExplanation(sold)).toMatch(/the creator sold some of this token/);
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
