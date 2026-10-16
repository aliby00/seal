import { afterEach, describe, expect, it, vi } from 'vitest';
import { findViolations } from '../../src/lib/agent/guardrails';
import { SIGNAL_LABEL } from '../../src/app/components/signal-labels';
import { CATALOG } from '../../src/lib/specialists/catalog';
import { SPECIALIST_IDS, type SpecialistContext } from '../../src/lib/specialists/types';
import { makeReport } from './helpers';

const gatherContext = vi.hoisted(() => vi.fn());
const readTokenMetas = vi.hoisted(() => vi.fn());
const liveIndex = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/specialists/context', () => ({ gatherContext }));
vi.mock('../../src/lib/specialists/live-index', () => ({ liveIndex }));
vi.mock('../../src/lib/chain/facts', () => ({ readTokenMetas }));

const { answerAll, briefSpecialists, WITHHELD_LINE } =
  await import('../../src/lib/specialists/brief');

const TOKEN = '0x1111111111111111111111111111111111111111';

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('answerAll', () => {
  it('asks all ten questions, in catalogue order, every time', () => {
    const answers = answerAll({ token: TOKEN, report: makeReport(TOKEN) });
    expect(answers.map((a) => a.specialist)).toEqual([...SPECIALIST_IDS]);
    for (const answer of answers) {
      expect(answer.title).toBe(CATALOG[answer.specialist].title);
      expect(answer.question).toBe(CATALOG[answer.specialist].question);
    }
  });

  it('turns a specialist that throws into a "not measured" answer, without stopping the others', () => {
    // A report missing its creator block makes some specialists throw.
    const broken = { token: TOKEN, report: { holders: {} } } as unknown as SpecialistContext;
    const answers = answerAll(broken);
    expect(answers).toHaveLength(10);
    expect(answers.every((a) => a.limits.length > 0 || a.facts.length > 0)).toBe(true);
    expect(
      answers.some((a) => a.limits.includes('this question could not be answered for this token')),
    ).toBe(true);
  });

  it('says a question timed out rather than that the market does not exist', () => {
    const answers = answerAll({ token: TOKEN }, { timedOut: true });
    const unanswered = answers.filter((a) => a.signal === 'unknown');
    expect(unanswered.length).toBeGreaterThan(0);
    for (const a of unanswered) {
      expect(a.limits).toEqual(['the on-chain lookups for this question did not finish in time']);
    }
  });

  it('withholds any served line that reads as a verdict', () => {
    const report = makeReport(TOKEN, (r) => {
      r.holders.completeness = 'unavailable';
      r.holders.sources = [{ name: 'blockscout', fetchedAt: 'x', note: 'this looks like a scam' }];
    });
    const spread = answerAll({ token: TOKEN, report }).find(
      (a) => a.specialist === 'holder-spread',
    );
    expect(spread?.limits).toEqual([WITHHELD_LINE]);
  });
});

describe('briefSpecialists', () => {
  it('returns the name and symbol, and answers from the gathered context', async () => {
    readTokenMetas.mockResolvedValue(new Map([[TOKEN, { name: 'Alpha', symbol: 'ALP' }]]));
    liveIndex.mockResolvedValue(undefined);
    gatherContext.mockResolvedValue({ token: TOKEN, report: makeReport(TOKEN), market: null });
    const brief = await briefSpecialists(TOKEN, makeReport(TOKEN));
    expect(brief.name).toBe('Alpha');
    expect(brief.symbol).toBe('ALP');
    expect(brief.answers).toHaveLength(10);
  });

  it('does not serve a name that reads as a verdict', async () => {
    readTokenMetas.mockResolvedValue(new Map([[TOKEN, { name: 'SAFE 100X', symbol: 'LEGIT' }]]));
    liveIndex.mockResolvedValue(undefined);
    gatherContext.mockResolvedValue({ token: TOKEN, market: null });
    const brief = await briefSpecialists(TOKEN, undefined);
    expect(brief.name).toBeNull();
    expect(brief.symbol).toBeNull();
  });

  it('answers within its time budget even when the chain does not', async () => {
    readTokenMetas.mockReturnValue(new Promise(() => {}));
    liveIndex.mockResolvedValue(undefined);
    gatherContext.mockReturnValue(new Promise(() => {}));
    const brief = await briefSpecialists(TOKEN, makeReport(TOKEN), { timeoutMs: 20 });
    expect(brief.answers).toHaveLength(10);
    expect(brief.name).toBeNull();
    const ruleChange = brief.answers.find((a) => a.specialist === 'rule-change');
    expect(ruleChange?.limits).toEqual([
      'the on-chain lookups for this question did not finish in time',
    ]);
  });
});

describe('wording', () => {
  it('no label, title or question carries a score, advice or a verdict', () => {
    const texts = [
      ...Object.values(SIGNAL_LABEL),
      ...SPECIALIST_IDS.flatMap((id) => [CATALOG[id].title, CATALOG[id].question]),
    ];
    for (const text of texts) expect(findViolations(text), text).toEqual([]);
  });
});
