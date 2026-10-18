import { findViolations } from '../agent/guardrails';
import { readTokenMetas } from '../chain/facts';
import type { MarketIndex } from '../chain/pools';
import { createRpcClient, type RpcClient } from '../chain/rpc';
import type { TokenReport } from '../contracts';
import { createBudget } from '../http';
import type { FailedRead } from '../contracts/report';
import {
  HOOK_COUNT_UNREAD_NOTE,
  QUESTION_FAILED as FAILED,
  QUESTION_TIMED_OUT as TIMED_OUT,
} from '../failed-reads';
import { log } from '../logger';
import { CATALOG, HOOK_COUNT_UNREAD } from './catalog';
import { discoverMarkets, fromReport, gatherContext, type MarketDiscovery } from './context';
import { liveIndex } from './live-index';
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
/** Requests these lookups may spend, on top of the collection's own budget. */
export const SPECIALIST_BUDGET = 20;

export const WITHHELD_LINE = '(line withheld: its wording reads as a verdict or advice)';
export { FAILED, TIMED_OUT };

/** The questions left unanswered by a timeout or a failure, by their limits. */
export function unansweredOf(answers: readonly SpecialistAnswer[]): SpecialistId[] {
  return answers
    .filter((a) => a.signal === 'unknown' && a.limits.some((l) => l === TIMED_OUT || l === FAILED))
    .map((a) => a.specialist);
}

/** The reads the answers fell back from: the hook's chain-wide count, for one. */
export function partialOf(answers: readonly SpecialistAnswer[]): FailedRead[] {
  return answers.some((a) => a.limits.includes(HOOK_COUNT_UNREAD))
    ? [{ read: 'questions', note: HOOK_COUNT_UNREAD_NOTE }]
    : [];
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
    try {
      const finding = specialist.run(context);
      signal = finding.signal;
      facts = finding.facts;
      limits = finding.limits;
      funding = finding.funding;
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
    };
  });
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/**
 * What the questions can read before the report is ready: the recent
 * markets, the token's own v4 markets, its name. Started alongside the
 * collection, so the questions do not wait for it and then for their own
 * reads one after the other (MEME: 39 s, two questions out of time).
 */
export type SpecialistStart = {
  rpc: RpcClient;
  index: Promise<MarketIndex | undefined>;
  discovery: Promise<MarketDiscovery>;
  metas: Promise<Awaited<ReturnType<typeof readTokenMetas>> | undefined>;
};

export function startSpecialists(
  token: string,
  options: { rpcUrl?: string } = {},
): SpecialistStart {
  const rpc = createRpcClient(options.rpcUrl, createBudget(SPECIALIST_BUDGET));
  const index = liveIndex(rpc).catch(() => undefined);
  const discovery = index.then((i) => discoverMarkets(rpc, token, i));
  // Read once settled: a failure here is the question's own "not found".
  discovery.catch(() => undefined);
  const metas = readTokenMetas(rpc, [token]).catch(() => undefined);
  return { rpc, index, discovery, metas };
}

/**
 * Gathers what the specialists need beyond the report — the v4 market, its
 * rulebook, the creator's wallet, the recent markets — under a time and
 * request budget, then asks the ten questions. Never throws.
 */
export async function briefSpecialists(
  token: string,
  report: TokenReport | undefined,
  options: { rpcUrl?: string; timeoutMs?: number; started?: SpecialistStart } = {},
): Promise<SpecialistBrief> {
  const started = options.started ?? startSpecialists(token, { rpcUrl: options.rpcUrl });
  const { rpc } = started;
  const timeoutMs = options.timeoutMs ?? SPECIALIST_TIMEOUT_MS;

  const metas = within(started.metas, timeoutMs).catch(() => undefined);
  let timedOut = false;
  const context = await within(
    (async () => {
      const index = await started.index;
      return gatherContext(rpc, token, report, index, started.discovery);
    })(),
    timeoutMs,
  ).catch((error: unknown): SpecialistContext => {
    timedOut = String(error).includes('timeout');
    log.warn('contexte des spécialistes incomplet', { token, error: String(error) });
    // What the report already holds is still answered: the main pool and
    // its rules, read by the collection.
    return {
      token: token.toLowerCase(),
      ...(report ? { report, ...fromReport(token, report) } : {}),
    };
  });

  const meta = (await metas)?.get(token.toLowerCase());
  const name = context.market?.name ?? meta?.name ?? null;
  const symbol = context.market?.symbol ?? meta?.symbol ?? null;
  const answers = answerAll(context, { timedOut });
  return {
    answers,
    unanswered: unansweredOf(answers),
    partial: partialOf(answers),
    // A token can name itself anything: cleaned, cut, and withheld when it reads as a verdict.
    name: displayName(name),
    symbol: displayName(symbol),
  };
}
