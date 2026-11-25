import type { TokenReport } from '../contracts';
import type { SpecialistContext } from './types';

/**
 * What the questions read: the collected report, and the creator it names.
 *
 * Every Solana question answers from the report alone (the mint and its
 * powers, the holders, the creator's history and funding, the launch, the
 * market), so nothing more is looked up here and nothing can time out. Kept
 * async so a lookup the report does not hold can be added without changing
 * the callers.
 */
export async function gatherContext(
  token: string,
  report: TokenReport | undefined,
): Promise<SpecialistContext> {
  return {
    token,
    ...(report ? { report, creator: report.creator.data.creator } : {}),
  };
}
