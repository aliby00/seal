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
