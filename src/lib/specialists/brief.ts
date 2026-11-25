import { findViolations } from '../agent/guardrails';
import type { TokenReport } from '../contracts';
import type { FailedRead } from '../contracts/report';
import { QUESTION_FAILED as FAILED, QUESTION_TIMED_OUT as TIMED_OUT } from '../failed-reads';
import { log } from '../logger';
import { CATALOG } from './catalog';
import { gatherContext } from './context';
import { displayName } from './names';
import {
  SPECIALIST_IDS,
  type FundingDisplay,
  type Signal,
  type SpecialistContext,
  type SpecialistId,
} from './types';

/**
 * The ten specialists, run on every analysis.
 *
 * They are deterministic and call no model: each one answers its own question
 * from what was collected, and each answer is served on its own. Nothing here
 * adds them up — there is no total, no share of "good" answers, no order by
 * signal. The catalogue order is fixed, so every report reads the same way.
 */

export type SpecialistAnswer = {
  specialist: SpecialistId;
  title: string;
  question: string;
  signal: Signal;
  facts: string[];
  limits: string[];
  /** The funding question only: what the funder is, and the path up from the creator. */
  funding?: FundingDisplay;
  /** The question does not apply to this token: not a gap in what was measured. */
  notApplicable?: true;
};

export type SpecialistBrief = {
  answers: SpecialistAnswer[];
  /**
   * The questions whose lookups did not finish in time, or that failed:
   * their answers are missing, not empty, and the report is partial.
   */
  unanswered: SpecialistId[];
  /**
   * Reads a question answered without, falling back on less: the report is
   * partial. Absent from briefs cached before it existed.
   */
  partial?: FailedRead[];
  /** The token's own name and symbol, read on chain. `null` when unreadable. */
  name: string | null;
  symbol: string | null;
};

/** Upper bound for the on-chain lookups; they run before the model writes, so they add to the wait. */
export const SPECIALIST_TIMEOUT_MS = 12_000;

export const WITHHELD_LINE = '(line withheld: its wording reads as a verdict or advice)';
export { FAILED, TIMED_OUT };

/** The questions left unanswered by a timeout or a failure, by their limits. */
export function unansweredOf(answers: readonly SpecialistAnswer[]): SpecialistId[] {
  return answers
    .filter((a) => a.signal === 'unknown' && a.limits.some((l) => l === TIMED_OUT || l === FAILED))
    .map((a) => a.specialist);
}

/**
 * The reads the answers fell back from, the report then partial.
 * TODO-SOLANA: none yet; the rewritten questions say theirs here.
 */
export function partialOf(answers: readonly SpecialistAnswer[]): FailedRead[] {
  void answers;
  return [];
}

/** Served text passes the same guardrails as the explanation, line by line. */
function screened(lines: readonly string[]): string[] {
  return lines.map((line) => (findViolations(line).length > 0 ? WITHHELD_LINE : line));
}

/** A contract name is chosen by its deployer: one that reads as a verdict is not shown. */
const shownName = (name: string | null): string | null =>
  name && findViolations(name).length === 0 ? name : null;

function screenedFunding(display: FundingDisplay): FundingDisplay {
  return {
    ...display,
    path: display.path.map((step) => ({
      ...step,
      name: shownName(step.name),
      ...(step.via ? { via: { ...step.via, name: shownName(step.via.name) } } : {}),
    })),
  };
}

/**
 * Asks every specialist its question. One that throws — a report missing a
 * block, an unexpected shape — answers "not measured" and says so; it never
 * takes the others down.
 */
export function answerAll(
  context: SpecialistContext,
  options: { timedOut?: boolean } = {},
): SpecialistAnswer[] {
  return SPECIALIST_IDS.map((id) => {
    const specialist = CATALOG[id];
    let signal: Signal = 'unknown';
    let facts: string[] = [];
    let limits: string[] = [FAILED];
    let funding: FundingDisplay | undefined;
    let notApplicable = false;
    try {
      const finding = specialist.run(context);
      signal = finding.signal;
      facts = finding.facts;
      limits = finding.limits;
      funding = finding.funding;
      notApplicable = finding.notApplicable === true;
    } catch (error) {
      log.warn('spécialiste en échec', { specialist: id, error: String(error) });
    }
    // An unanswered question after a timeout was not answered because time
    // ran out, not because the market does not exist: say which.
    if (options.timedOut && signal === 'unknown') limits = [TIMED_OUT];
    return {
      specialist: id,
      title: specialist.title,
      question: specialist.question,
      signal,
      facts: screened(facts),
      limits: screened(limits),
      ...(funding ? { funding: screenedFunding(funding) } : {}),
      ...(notApplicable && !options.timedOut ? { notApplicable: true as const } : {}),
    };
  });
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * What the questions can read before the report is ready, started alongside
 * the collection. TODO-SOLANA: nothing yet; the EVM lookups started here
 * (recent v4 markets, the token's markets, its name) are gone.
 */
export type SpecialistStart = Record<string, never>;

export function startSpecialists(token: string): SpecialistStart {
  void token;
  return {};
}

/**
 * Asks the ten questions, from the report and what `gatherContext` adds,
 * under a time limit. Never throws.
 */
export async function briefSpecialists(
  token: string,
  report: TokenReport | undefined,
  options: { timeoutMs?: number; started?: SpecialistStart } = {},
): Promise<SpecialistBrief> {
  const timeoutMs = options.timeoutMs ?? SPECIALIST_TIMEOUT_MS;
  let timedOut = false;
  const context = await within(gatherContext(token, report), timeoutMs).catch(
    (error: unknown): SpecialistContext => {
      timedOut = String(error).includes('timeout');
      log.warn('contexte des spécialistes incomplet', { token, error: String(error) });
      return { token, ...(report ? { report } : {}) };
    },
  );
  const meta = report?.mint.data?.metadata;
  const answers = answerAll(context, { timedOut });
  return {
    answers,
    unanswered: unansweredOf(answers),
    partial: [
      ...partialOf(answers),
      ...(context.unread?.length
        ? [
            {
              read: 'questions' as const,
              note: `some lookups of the ten questions could not be read this time (${[...new Set(context.unread)].join(', ')})`,
            },
          ]
        : []),
    ],
    // A token can name itself anything: cleaned, cut, and withheld when it reads as a verdict.
    name: displayName(meta?.name),
    symbol: displayName(meta?.symbol),
  };
}
