import { describe, expect, it } from 'vitest';
import { findViolations, isCompliant } from '../../src/lib/agent/guardrails';
import { FINDINGS_SYSTEM_PROMPT, servedText } from '../../src/lib/agent/investigate';
import { offlineExplanation } from '../../src/lib/agent/offline';
import { renderReport, SYSTEM_PROMPT } from '../../src/lib/agent/prompt';
import { explain } from '../../src/lib/agent/reason';
import { launchView, toFacts, toTimeline } from '../../src/lib/facts';
import { buildGlance } from '../../src/lib/glance';
import { answerAll } from '../../src/lib/specialists/brief';
import { COLLECT_TOKENS, loadCollectRecording } from '../collect/recording';

/** Words of the chain SEAL no longer reads: none may reach the model or the reader. */
const EVM =
  /robinhood|blockscout|\bpons\b|doppler|uniswap|hook\s*v4|v4\s*hook|\bETH\b|PoolManager/i;

describe('the system prompt describes Solana', () => {
  it.each([
    'pump.fun',
    'bonding curve',
    'graduates',
    'PumpSwap',
    'Meteora',
    'Raydium',
    'LaunchLab',
    'Token-2022',
    'permanent delegate',
    'transfer hook',
    'transfer fee',
    'freeze authority',
    'creation slot',
    'received SOL from the creator',
  ])('names %s', (term) => {
    expect(SYSTEM_PROMPT).toContain(term);
  });

  it('says nothing of the chain SEAL no longer reads', () => {
    expect(SYSTEM_PROMPT).not.toMatch(EVM);
    expect(FINDINGS_SYSTEM_PROMPT).not.toMatch(EVM);
  });

  it('still forbids scores, advice and intent labels', () => {
    expect(SYSTEM_PROMPT).toMatch(/NEVER assign a score/);
    expect(SYSTEM_PROMPT).toMatch(
      /good or bad investment, safe, or something to buy, sell or avoid/,
    );
    expect(SYSTEM_PROMPT).toMatch(/no "sniper", "insider", "bundle"/);
    expect(SYSTEM_PROMPT).toMatch(/never write that the creator controls them/);
  });
});

describe('the guardrails, on Solana wording', () => {
  it.each([
    ['a token called safe', 'The mint authority is revoked, so this token is safe.'],
    ['a scam', 'The creator sold everything: a classic pump.fun scam.'],
    ['a rug', 'Wallets funded by the creator dumped on the curve before the rug.'],
    ['a rug pull, negated', 'The PumpSwap LP is burned, so this is not a rug pull.'],
    ['a score', 'Holder spread: 3/10.'],
    ['a rating', 'Token-2022 risk score: 7'],
    ['advice', 'You should sell before the permanent delegate acts.'],
    ['a risk level', 'No freeze authority and no transfer hook: low risk.'],
    ['an intent label', 'Two snipers bought in the creation slot.'],
    ['an intent label', 'The bundle in the creation slot got 39% of the supply.'],
  ])('blocks %s', (_, text) => {
    expect(isCompliant(text)).toBe(false);
  });

  it.each([
    'Two wallets other than the creator got 39.5% of the supply in the creation slot.',
    'Someone can take or burn any holder’s tokens (permanent delegate).',
    'The creator sold 11.9% of the supply, all it had bought, 2 of 2 transactions read.',
    'In the first 5 seconds, 12 addresses bought 44.5% of the supply; 5 sold back.',
    'Every transfer pays a 5% fee.',
  ])('lets a Solana fact through: %s', (text) => {
    expect(findViolations(text)).toEqual([]);
  });

  it('withholds a whole served text that words a verdict', () => {
    expect(servedText('The curve is safe.')).toMatch(/could not be worded within SEAL’s rules/);
  });

  it('serves the facts instead of a model output that calls a Solana token a rug', async () => {
    const report = loadCollectRecording('pump-creator-sold').report;
    const result = await explain(report, {
      model: 'claude-sonnet-5-5',
      provider: {
        name: 'anthropic',
        complete: async () => ({
          text: 'What deserves attention\n\nThe creator sold everything into the curve: a rug.',
          usage: { input_tokens: 10, output_tokens: 10 },
          stopReason: 'end_turn',
        }),
      },
    });
    expect(result.offline).toBe(true);
    expect(result.rejected).toBe(true);
    expect(result.text).not.toMatch(/\brug\b/i);
    expect(findViolations(result.text)).toEqual([]);
  });
});

describe('every text SEAL writes, on the tokens recorded on mainnet', () => {
  for (const { slug } of COLLECT_TOKENS) {
    it(`${slug}: the summary, the offline account and the model's input pass the guardrails`, () => {
      const report = loadCollectRecording(slug).report;
      const answers = answerAll({
        token: report.token,
        report,
        creator: report.creator.data.creator,
      });
      const view = launchView(report.launch);
      const glance = buildGlance({
        facts: toFacts(report),
        timeline: toTimeline(report),
        ...(view ? { launch: view } : {}),
        specialists: answers,
      })!;
      const offline = offlineExplanation(report, answers);
      expect(findViolations(JSON.stringify(glance))).toEqual([]);
      expect(findViolations(offline)).toEqual([]);
      for (const text of [JSON.stringify(glance), offline, renderReport(report, answers)]) {
        expect(text).not.toMatch(EVM);
      }
    });
  }

  it('pump-creator-sold: the summary leads with an empty curve, the sale and the creation slot', () => {
    const report = loadCollectRecording('pump-creator-sold').report;
    const answers = answerAll({
      token: report.token,
      report,
      creator: report.creator.data.creator,
    });
    const view = launchView(report.launch);
    const glance = buildGlance({
      facts: toFacts(report),
      timeline: toTimeline(report),
      ...(view ? { launch: view } : {}),
      specialists: answers,
    })!;
    expect(glance.items.map((i) => [i.id, i.tone])).toEqual([
      ['market', 'attention'],
      ['sales', 'attention'],
      ['launch-buys', 'attention'],
      ['supply', 'neutral'],
    ]);
    expect(glance.items[1]!.title).toBe(
      'The creator sold 12% of the supply, all it had bought, and holds none of it today.',
    );
  });

  it('pyusd: the summary leads with the powers kept over every holder', () => {
    const report = loadCollectRecording('pyusd').report;
    const answers = answerAll({
      token: report.token,
      report,
      creator: report.creator.data.creator,
    });
    const glance = buildGlance({ facts: toFacts(report), specialists: answers })!;
    expect(glance.headline).toBe(
      'Someone can still create new tokens, freeze any holder’s tokens, take or burn any holder’s tokens, add a program that can refuse transfers and set a transfer fee of up to 100%.',
    );
    // The model is told the same thing, under "What deserves attention".
    expect(renderReport(report, answers)).toContain(`- ${glance.headline}`);
  });
});
