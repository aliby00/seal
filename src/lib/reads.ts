import type { FailedRead, ReadId } from './contracts/report';
import { IncompleteDataError, SealError } from './errors';
import { log } from './logger';

/**
 * Every optional read of a collection, and what its failure costs.
 *
 * ASTEROID on staging, 18/10/2026: the fees the market's hook paid the
 * creator (6.907 % of the supply in 52 transfers) were read over a window
 * the node cut short, the read answered "nothing", and the report went out
 * without them, with no partial notice, and was cached. Asked again, it had
 * them. A read has three outcomes, never two: it answered, it does not apply
 * to this token, or it failed — and a failure is always a failed read.
 */
export type ReadOutcome<T> =
  { status: 'ok'; value: T } | { status: 'not-applicable' } | { status: 'failed'; error: unknown };

/** What each optional read is filed under when it fails, and what is lost. */
export const OPTIONAL_READS = {
  'creator-wallet': {
    read: 'creator-wallet',
    note: 'how many transactions the creator’s wallet has sent could not be read this time',
  },
  'other-launchpads': {
    read: 'creator-launches',
    note: 'the creator’s launches on other launchpads could not be read this time',
  },
  'indexer-markets': {
    read: 'market-rules',
    note: 'the SEAL indexer did not answer: the token’s v4 markets and their trading rules (hooks) could not be read this time',
  },
  'pool-rules': {
    read: 'market-rules',
    note: 'the trading rules (hook) of the token’s listed v4 pools could not be read this time',
  },
  'pools-share': {
    read: 'liquidity',
    note: 'what the token’s pools hold on chain today could not be read this time',
  },
  'holder-codes': {
    read: 'holders',
    note: 'which of the largest holders are wallets rather than contracts could not be read again this time',
  },
  'holder-links': {
    read: 'holders',
    note: 'which holders received tokens from the creator could not be read this time',
  },
  'creator-fees': {
    read: 'creator-fees',
    note: 'the fees the market’s trading rules (hooks) paid the creator could not be read this time',
  },
  graduation: {
    read: 'graduation',
    note: 'the launch’s progress toward graduation could not be read this time',
  },
  'launch-replay': {
    read: 'launch-replay',
    note: 'the first minutes after the launch could not be read this time',
  },
  'address-roles': {
    read: 'holders',
    note: 'what the largest holders and the launch’s recipients are (locks, pools, launchpad wallets) could not be read this time',
  },
  'indexer-token': {
    read: 'market',
    note: 'the SEAL indexer did not answer: the launch pool’s trades could not be read this time',
  },
} as const satisfies Record<string, { read: ReadId; note: string }>;

export type OptionalRead = keyof typeof OPTIONAL_READS;

/** Returned by a read that does not apply to this token: not a failure, not a finding. */
export const NOT_APPLICABLE: unique symbol = Symbol('not-applicable');

/** An error as a short reason, its kind first. */
export function reasonOf(error: unknown): string {
  return error instanceof SealError
    ? `${error.kind} : ${error.message}`
    : error instanceof Error
      ? error.message
      : 'unknown failure';
}

/**
 * The failed reads of one collection. Each optional read goes through `read`
 * (or reports a failure it detected itself through `fail`): a read that
 * throws is filed, with its reason, and the caller gets `failed`, never a
 * value that would read as "nothing found".
 */
export class ReadLedger {
  private readonly failures: FailedRead[] = [];
  /** How long each read took, in ms, for the collection's log line. */
  readonly timings: Partial<Record<OptionalRead, number>> = {};

  /**
   * `deadline` (epoch ms): a read still running then did not finish, and the
   * collection goes on without it. The reads after the holders ran one after
   * another past the route's 30 s (0x2e8c…: fees done at 33.6 s, staging
   * 07/11/2026), and the whole report was lost to a 504.
   */
  constructor(private readonly deadline?: number) {}

  async read<T>(
    name: OptionalRead,
    fn: () => Promise<T | typeof NOT_APPLICABLE>,
  ): Promise<ReadOutcome<T>> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = fn();
      const value =
        this.deadline === undefined
          ? await run
          : await Promise.race([
              run,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new IncompleteDataError(
                        'robinhood-rpc',
                        'it did not finish in time this time',
                      ),
                    ),
                  Math.max(0, this.deadline! - Date.now()),
                );
              }),
            ]);
      return value === NOT_APPLICABLE ? { status: 'not-applicable' } : { status: 'ok', value };
    } catch (error) {
      this.fail(name, error);
      return { status: 'failed', error };
    } finally {
      clearTimeout(timer);
      this.timings[name] = (this.timings[name] ?? 0) + Date.now() - started;
    }
  }

  /** Files `name` as failed: a read that answered but could not cover what it meant to. */
  fail(name: OptionalRead, error?: unknown): void {
    const { read, note } = OPTIONAL_READS[name];
    const reason = error === undefined ? undefined : reasonOf(error);
    log.warn('lecture optionnelle en échec', { read: name, reason });
    this.failures.push({ read, note: reason ? `${note} (${reason})` : note });
  }

  /** Adds a failure filed elsewhere (the creator's history, the holders list). */
  push(...failures: FailedRead[]): void {
    this.failures.push(...failures);
  }

  get all(): readonly FailedRead[] {
    return this.failures;
  }
}

/** The value of an outcome, or `fallback` when it failed or does not apply. */
export function valueOr<T, F>(outcome: ReadOutcome<T>, fallback: F): T | F {
  return outcome.status === 'ok' ? outcome.value : fallback;
}
