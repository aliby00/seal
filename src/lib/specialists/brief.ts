import { findViolations } from '../agent/guardrails';
import { readTokenMetas } from '../chain/facts';
import { createRpcClient } from '../chain/rpc';
import type { TokenReport } from '../contracts';
import { createBudget } from '../http';
import { log } from '../logger';
import { CATALOG } from './catalog';
import { gatherContext } from './context';
import { liveIndex } from './live-index';
import { SPECIALIST_IDS, type Signal, type SpecialistContext, type SpecialistId } from './types';

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
};

export type SpecialistBrief = {
  answers: SpecialistAnswer[];
  /** The token's own name and symbol, read on chain. `null` when unreadable. */
  name: string | null;
  symbol: string | null;
};

/** The on-chain lookups run beside the model call: they must be done before it is. */
export const SPECIALIST_TIMEOUT_MS = 12_000;
/** Requests these lookups may spend, on top of the collection's own budget. */
export const SPECIALIST_BUDGET = 20;

export const WITHHELD_LINE = '(line withheld: its wording reads as a verdict or advice)';
const TIMED_OUT = 'the on-chain lookups for this question did not finish in time';
const FAILED = 'this question could not be answered for this token';

/** Served text passes the same guardrails as the explanation, line by line. */
function screened(lines: readonly string[]): string[] {
  return lines.map((line) => (findViolations(line).length > 0 ? WITHHELD_LINE : line));
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
    try {
      const finding = specialist.run(context);
      signal = finding.signal;
      facts = finding.facts;
      limits = finding.limits;
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
 * Gathers what the specialists need beyond the report — the v4 market, its
 * rulebook, the creator's wallet, the recent markets — under a time and
 * request budget, then asks the ten questions. Never throws.
 */
export async function briefSpecialists(
  token: string,
  report: TokenReport | undefined,
  options: { rpcUrl?: string; timeoutMs?: number } = {},
): Promise<SpecialistBrief> {
  const rpc = createRpcClient(options.rpcUrl, createBudget(SPECIALIST_BUDGET));
  const timeoutMs = options.timeoutMs ?? SPECIALIST_TIMEOUT_MS;

  const metas = within(readTokenMetas(rpc, [token]), timeoutMs).catch(() => undefined);
  let timedOut = false;
  const context = await within(
    (async () => {
      const index = await liveIndex(rpc).catch(() => undefined);
      return gatherContext(rpc, token, report, index);
    })(),
    timeoutMs,
  ).catch((error: unknown): SpecialistContext => {
    timedOut = String(error).includes('timeout');
    log.warn('contexte des spécialistes incomplet', { token, error: String(error) });
    return { token: token.toLowerCase(), ...(report ? { report } : {}) };
  });

  const meta = (await metas)?.get(token.toLowerCase());
  const name = context.market?.name ?? meta?.name ?? null;
  const symbol = context.market?.symbol ?? meta?.symbol ?? null;
  return {
    answers: answerAll(context, { timedOut }),
    // A token can name itself anything: a name that reads as a verdict is not shown.
    name: name && findViolations(name).length === 0 ? name : null,
    symbol: symbol && findViolations(symbol).length === 0 ? symbol : null,
  };
}
