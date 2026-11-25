import { describe, expect, it } from 'vitest';
import { investigate, offlineFindings, renderFindings } from '../../src/lib/agent/investigate';
import { findViolations } from '../../src/lib/agent/guardrails';
import { gatherContext } from '../../src/lib/specialists/context';
import { compileAgent, InvalidAgentSpecError } from '../../src/lib/specialists/compose';
import { isFlagged, MAX_LEADS, measureDivergence, runAgent } from '../../src/lib/specialists/run';
import { loadCollectRecording } from '../collect/recording';

/**
 * A composed agent replayed on a recorded token: which questions it asks,
 * which leads it follows, whether it flags the token. The board that
 * compares agents reads exactly this, so it must hold on Solana answers.
 */
describe('agents composed from the Solana questions', () => {
  it('accepts the new questions and refuses the retired ones', () => {
    const agent = compileAgent({
      name: 'powers first',
      specialists: ['token-powers', 'transfer-rules'],
    });
    expect(agent.specialists).toEqual(['token-powers', 'transfer-rules']);
    for (const retired of ['code-reuse', 'rule-change']) {
      expect(() => compileAgent({ name: 'old', specialists: [retired] })).toThrow(
        InvalidAgentSpecError,
      );
    }
  });

  it('follows the leads a concern names, once, within the bound', async () => {
    const report = loadCollectRecording('pyusd').report;
    const context = await gatherContext(report.token, report);
    expect(context.creator).toBe(report.creator.data.creator);
    const agent = compileAgent({ name: 'powers', specialists: ['token-powers'] });
    const { findings, leads } = runAgent(agent, context);
    // A freeze authority held points to whether holders can sell.
    expect(leads).toContain('sell-path');
    expect(leads.length).toBeLessThanOrEqual(MAX_LEADS);
    expect(findings.map((f) => f.specialist)).toEqual(['token-powers', ...leads]);
  });

  it('flags by the chosen questions only, never by a lead', async () => {
    const report = loadCollectRecording('pump-creator-sold').report;
    const context = await gatherContext(report.token, report);
    const careful = compileAgent({
      name: 'careful',
      specialists: ['creator-history', 'token-powers'],
    });
    const discreet = compileAgent({
      name: 'discreet',
      specialists: ['creator-history', 'token-powers'],
      preferences: { flagOn: 'two-concerns' },
    });
    const { findings } = runAgent(careful, context);
    // The creator sold this token (concern); nobody can mint or freeze (reassurance).
    expect(findings.find((f) => f.specialist === 'creator-history')?.signal).toBe('concern');
    expect(findings.find((f) => f.specialist === 'token-powers')?.signal).toBe('reassurance');
    expect(isFlagged(careful, findings)).toBe(true);
    expect(isFlagged(discreet, findings)).toBe(false);
    expect(measureDivergence(findings).conflicts).toBe(1);
  });

  it('words the findings offline within the rules, Solana terms only', async () => {
    const report = loadCollectRecording('meteora-dbc').report;
    const context = await gatherContext(report.token, report);
    const agent = compileAgent({
      name: 'all',
      specialists: ['token-powers', 'holder-spread', 'volume-reality', 'wallet-age'],
    });
    const result = await investigate(agent, context, { offline: true });
    expect(result.offline).toBe(true);
    expect(findViolations(result.text)).toEqual([]);
    const rendered = renderFindings(agent, result.findings, result.leads);
    expect(rendered).toContain('## Token Powers');
    expect(`${rendered}\n${offlineFindings(result.findings)}`).not.toMatch(
      /robinhood|blockscout|\bpons\b|doppler|uniswap|\bhook\b(?! authority)/i,
    );
  });
});
