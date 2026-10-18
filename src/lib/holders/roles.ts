import type {
  Holder,
  HolderDistributionData,
  NamedAddress,
  SetAsideHolding,
  SetAsideRole,
} from '../contracts';

/**
 * The holders list once the chain has said what its addresses are.
 *
 * A vesting lock holds tokens that cannot be sold before they unlock, and a
 * pool no listing names holds liquidity: neither is anyone's position, so
 * both are set aside like the token's other pools, and the shares of the
 * others are measured again without them. SIRIUS: its "largest holder, a
 * contract, 28 %" was Virtuals' TokenTable lock for the creator, locked until
 * 29/11/2026 and 28/08/2027; its 5.7 % "contract", a V3 pool against USDG.
 * Every other holder keeps its place and is given its name.
 */

const SET_ASIDE_KIND: Partial<Record<NamedAddress['kind'], SetAsideRole>> = {
  vesting: 'vesting',
  pool: 'pool',
  curve: 'curve',
  launchpad: 'launchpad',
};

const share6 = (value: bigint, base: bigint) =>
  base > 0n ? Number((value * 1_000_000n) / base) / 1_000_000 : 0;

const big = (value: string): bigint => {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

export function withRoles(
  data: HolderDistributionData,
  names: readonly NamedAddress[],
  /** The whole supply; null when unknown, and the part set aside is then not restated. */
  supply: bigint | null,
): HolderDistributionData {
  if (names.length === 0 || data.top.length === 0) return data;
  const byAddress = new Map(names.map((n) => [n.address.toLowerCase(), n]));
  const nameOf = (address: string) => byAddress.get(address.toLowerCase());
  const counted = (h: Holder) => h.kind === 'wallet' || h.kind === 'contract';

  const moved = data.top.filter((h) => {
    const n = nameOf(h.address);
    return counted(h) && n !== undefined && !n.tradable && SET_ASIDE_KIND[n.kind] !== undefined;
  });
  const movedTotal = moved.reduce((sum, h) => sum + big(h.balance), 0n);
  const before = big(data.countedSupply);
  const circulating = before > movedTotal ? before - movedTotal : before;
  const movedSet = new Set(moved.map((h) => h.address.toLowerCase()));

  const top: Holder[] = data.top
    .map((h): Holder => {
      const n = nameOf(h.address);
      const named = n ? { name: n.name } : {};
      if (movedSet.has(h.address.toLowerCase()) && n) {
        return { ...h, ...named, kind: 'pool', role: SET_ASIDE_KIND[n.kind]!, share: 0 };
      }
      return movedTotal > 0n && counted(h)
        ? { ...h, ...named, share: share6(big(h.balance), circulating) }
        : { ...h, ...named };
    })
    .sort((a, b) => b.share - a.share);
  const kept = top.filter(counted);

  const whole = supply !== null && supply > 0n ? supply : null;
  const added: SetAsideHolding[] = moved.map((h) => {
    const n = nameOf(h.address)!;
    return {
      address: h.address.toLowerCase(),
      role: SET_ASIDE_KIND[n.kind]!,
      share: whole !== null ? share6(big(h.balance), whole) : null,
      name: n.name,
    };
  });
  const setAside = [...(data.setAside ?? []), ...added]
    .map((s) => {
      const n = nameOf(s.address);
      return n && !s.name ? { ...s, name: n.name } : s;
    })
    .sort((a, b) => (b.share ?? 0) - (a.share ?? 0));
  const pooledShare =
    data.pooledShare !== null && data.pooledShare !== undefined && whole !== null
      ? Math.min(1, data.pooledShare + share6(movedTotal, whole))
      : (data.pooledShare ?? null);

  return {
    ...data,
    countedSupply: circulating.toString(),
    top,
    concentration:
      movedTotal > 0n
        ? {
            top1: kept[0]?.share ?? 0,
            top10: kept.slice(0, 10).reduce((sum, h) => sum + h.share, 0),
          }
        : data.concentration,
    pooledShare,
    setAside,
    ...(data.holderCount !== null && moved.length > 0
      ? { holderCount: Math.max(0, data.holderCount - moved.length) }
      : {}),
  };
}
