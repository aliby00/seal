import { LAUNCH_HOOKS } from './chain/launchpads';
import type { FeePayer } from './contracts/creator';
import type { SetAsideRole } from './contracts/holders';

/**
 * Where the part of the supply that no one holds sits, said in plain words:
 * a launch curve, trading pools, launch contracts, burn addresses. Shared by
 * the report's opening, the holders card and the questions, so they never
 * call a launchpad's curve "the pool" in one place and "a holder" in another.
 */

const WORD: Record<SetAsideRole, string> = {
  pool: 'trading pools',
  'pool-manager': 'trading pools',
  curve: 'launch curve',
  launchpad: 'launch contracts',
  locker: 'liquidity lock contract',
  hook: 'trading-rules contracts',
  burn: 'burn addresses',
};

/** "its launch curve", "its trading pools and launch contracts"; a generic phrase when unknown. */
export function whereSetAside(
  setAside: readonly { role: SetAsideRole; share: number | null }[] | undefined,
): string {
  const roles = [...new Set((setAside ?? []).map((s) => WORD[s.role]))];
  if (roles.length === 0) return 'its pools';
  const list =
    roles.length === 1
      ? roles[0]
      : `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}`;
  return `its ${list}`;
}

/** The role of one set-aside address, for a single line ("a launch curve"). */
export function roleWord(role: SetAsideRole): string {
  return {
    pool: 'a trading pool',
    'pool-manager': 'the Uniswap v4 pool manager',
    curve: 'a launch curve',
    launchpad: 'a launch contract',
    locker: 'a liquidity lock contract',
    hook: 'the trading rules (hook) of a market',
    burn: 'a burn address',
  }[role];
}

/**
 * The contracts that paid the creator fees, named by what they are to this
 * token: "the market’s trading rules (hook)" only for the hook of its main
 * pool (ASTEROID, BONER: Doppler’s 0x4e34…), Doppler’s launch contract by
 * that role where the main pool runs no hook (MEME).
 */
export function feePayerWords(
  payers: readonly FeePayer[] | undefined,
  hooks: readonly string[],
): string {
  const list: FeePayer[] = payers?.length
    ? [...payers]
    : hooks.map((address) => ({ address, role: 'hook' as const }));
  const words = list.map(({ address, role }) => {
    const a = address.toLowerCase();
    if (role === 'main-hook') return `the trading rules (hook) of its main pool, ${a}`;
    // A launchpad's contract is named by its role wherever it is not the
    // main pool's hook, in reports made before the role was read too.
    const known = LAUNCH_HOOKS.find((h) => h.address === a);
    if (known) return `${known.payer} (${a})`;
    if (role === 'pool-hook') return `the trading rules (hook) of another of its pools, ${a}`;
    return payers?.length
      ? `the trading rules (hook) ${a} of a market of this token`
      : `the contract ${a}`;
  });
  return words.length <= 1
    ? (words[0] ?? 'a contract')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
