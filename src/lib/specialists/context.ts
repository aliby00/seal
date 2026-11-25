import type { TokenReport } from '../contracts';
import type { SpecialistContext } from './types';

/**
 * What the questions read beyond the report.
 *
 * TODO-SOLANA: the EVM lookups (the token's v4 market and its hook, the
 * rulebook's code, the indexer's counts, Blockscout's funding) went away
 * with the EVM reads. The context is the report alone until the questions
 * are rewritten on it; their extra Solana lookups, if any, belong here.
 */
export async function gatherContext(
  token: string,
  report: TokenReport | undefined,
): Promise<SpecialistContext> {
  return {
    token,
    ...(report ? { report, creator: report.creator.data.creator } : {}),
    unread: [],
  };
}
