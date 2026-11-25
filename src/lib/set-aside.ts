import type { SetAsideRole } from './contracts/holders';

/**
 * Where the part of the supply that no one holds sits, said in plain words:
 * a launchpad's bonding curve (pump.fun, Meteora DBC, Raydium LaunchLab),
 * trading pools (PumpSwap, Raydium, Meteora, Orca), locks (Jupiter Lock,
 * Streamflow), the incinerator. Shared by the report's opening, the holders
 * card and the questions, so they never call a curve "the pool" in one place
 * and "a holder" in another.
 */

const WORD: Record<SetAsideRole, string> = {
  pool: 'its trading pools',
  curve: 'its bonding curve',
  launchpad: 'its launchpad accounts',
  locker: 'a liquidity lock',
  vesting: 'locks',
  burn: 'the incinerator',
};

/**
 * "its bonding curve", "its trading pools and locks"; when nothing was found
 * set aside, a phrase that gives the token no curve or pool it may not have
 * (USDC's card said "outside its curve and pools", 25/11/2026).
 */
export function whereSetAside(
  setAside: readonly { role: SetAsideRole; share: number | null }[] | undefined,
): string {
  const roles = [...new Set((setAside ?? []).map((s) => WORD[s.role]))];
  if (roles.length === 0) return 'any curve, pool or lock';
  return roles.length === 1
    ? roles[0]!
    : `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}`;
}

/** The role of one set-aside address, for a single line ("a bonding curve"). */
export function roleWord(role: SetAsideRole): string {
  return {
    pool: 'a trading pool',
    curve: 'a bonding curve',
    launchpad: 'a launchpad account',
    locker: 'a liquidity lock',
    vesting: 'a lock',
    burn: 'the incinerator',
  }[role];
}
