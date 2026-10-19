import { launchInfrastructure } from '../chain/launchpads';
import type {
  Holder,
  HolderDistribution,
  HolderDistributionData,
  SetAsideRole,
} from '../contracts';
import { IncompleteDataError } from '../errors';
import { requestJson, type RequestBudget } from '../http';
import { log } from '../logger';
import {
  holdersUrl,
  tokenUrl,
  type BlockscoutHolder,
  type BlockscoutHoldersPage,
  type BlockscoutToken,
} from './blockscout';

export * from './blockscout';

/** Adresses qui ne sont pas des détenteurs au sens où on l'entend. */
const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

export type FetchHoldersOptions = {
  apiKey?: string;
  budget?: RequestBudget;
  baseUrl?: string;
  /** Adresse du pool, à exclure du calcul de concentration. */
  poolAddress?: string;
  /** Other addresses holding liquidity, not positions (the DEX pair, the v4 PoolManager). */
  liquidityAddresses?: readonly string[];
  /**
   * Every address known to hold the token for trading or for its launch, with
   * why: the launch pool, the pairs listed since, the launchpad's curve, the
   * contract the launch called. Known launchpads and lock contracts are added
   * whatever the caller passes.
   */
  setAside?: readonly { address: string; role: SetAsideRole }[];
  /** Nombre de pages à parcourir. Le tier gratuit est à 5 req/s. */
  maxPages?: number;
  topN?: number;
  now?: () => Date;
};

/** What Blockscout says of the token as a whole, beyond the pages read. */
export type TokenTotals = {
  /** Every address with a balance, pools and burn included. */
  holders: number | null;
  /** Raw total supply, used as the base when the list is cut. */
  supply: bigint | null;
  /**
   * The list holds every balance: its sum is the supply, and the part set
   * aside can be measured against it without the total supply.
   */
  complete?: boolean;
};

/** The v4 PoolManager holds every v4 market's liquidity; it is never a holder. */
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

/** Why each set-aside address is set aside, the caller's list over the known infrastructure. */
export function setAsideRoles(
  options: Pick<FetchHoldersOptions, 'poolAddress' | 'liquidityAddresses' | 'setAside'> = {},
): Map<string, SetAsideRole> {
  const roles = new Map<string, SetAsideRole>(launchInfrastructure());
  roles.set(POOL_MANAGER, 'pool-manager');
  for (const address of options.liquidityAddresses ?? []) roles.set(address.toLowerCase(), 'pool');
  for (const { address, role } of options.setAside ?? []) roles.set(address.toLowerCase(), role);
  if (options.poolAddress && options.poolAddress !== '0x') {
    roles.set(options.poolAddress.toLowerCase(), 'pool');
  }
  return roles;
}

export function roleOf(
  address: string,
  roles: ReadonlyMap<string, SetAsideRole>,
): SetAsideRole | undefined {
  const lower = address.toLowerCase();
  if (BURN_ADDRESSES.has(lower)) return 'burn';
  return roles.get(lower);
}

export function classifyHolder(
  address: string,
  isContract: boolean,
  poolAddress?: string,
  liquidity: readonly string[] = [],
  roles: ReadonlyMap<string, SetAsideRole> = setAsideRoles({
    poolAddress,
    liquidityAddresses: liquidity,
  }),
): Holder['kind'] {
  const role = roleOf(address, roles);
  if (role === 'burn') return 'burn';
  if (role) return 'pool';
  return isContract ? 'contract' : 'wallet';
}

const share6 = (value: bigint, base: bigint) =>
  base > 0n ? Number((value * 1_000_000n) / base) / 1_000_000 : 0;

/**
 * Calcule les parts sur l'offre **hors pool et hors burn**.
 *
 * Sans cette exclusion, le pool ressort systématiquement comme détenteur
 * majoritaire et la concentration ne veut plus rien dire : c'est la liquidité,
 * pas une position d'un acteur. The same holds for a launchpad's curve, its
 * contracts and its lock contract: a flap.sh portal holding 99.9 % of a token
 * still on its curve was shown as "one holder with 99.9 %".
 */
export function computeDistribution(
  token: string,
  raw: BlockscoutHolder[],
  options: FetchHoldersOptions = {},
  totals: TokenTotals = { holders: null, supply: null },
): HolderDistributionData {
  const topN = options.topN ?? 20;
  const roles = setAsideRoles(options);

  const entries = raw
    .map((item) => {
      const address = item.address?.hash ?? '';
      const balance = BigInt(item.value ?? '0');
      const role = address ? roleOf(address, roles) : undefined;
      return {
        address,
        balance,
        role,
        kind: classifyHolder(
          address,
          item.address?.is_contract ?? false,
          undefined,
          undefined,
          roles,
        ),
      };
    })
    .filter((entry) => entry.address !== '');

  const isSetAside = (entry: { kind: Holder['kind'] }) =>
    entry.kind === 'pool' || entry.kind === 'burn';
  const listed = entries.filter((e) => !isSetAside(e)).reduce((sum, e) => sum + e.balance, 0n);
  const setAside = entries.filter(isSetAside).reduce((sum, e) => sum + e.balance, 0n);
  // When the list is cut, the holders read are not the whole supply: shares
  // measured against them alone would overstate every one of them. The total
  // supply, less the pools and burn addresses, is the true base.
  const fromSupply = totals.supply !== null ? totals.supply - setAside : null;
  const circulating = fromSupply !== null && fromSupply > listed ? fromSupply : listed;
  // The part set aside is measured against the whole supply: the total when
  // known, or the sum of a list that holds every balance.
  const whole =
    totals.supply !== null && totals.supply > 0n
      ? totals.supply
      : totals.complete && listed + setAside > 0n
        ? listed + setAside
        : null;

  const holders: Holder[] = entries
    .map((entry) => ({
      address: entry.address,
      balance: entry.balance.toString(),
      share: !isSetAside(entry) ? share6(entry.balance, circulating) : 0,
      kind: entry.kind,
      ...(entry.role ? { role: entry.role } : {}),
    }))
    .sort((a, b) => b.share - a.share);

  const counted = holders.filter((h) => h.kind === 'wallet' || h.kind === 'contract');
  const setAsideList = entries
    .filter((e) => isSetAside(e) && e.balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
    .slice(0, 10)
    .map((e) => ({
      address: e.address.toLowerCase(),
      role: e.role ?? (e.kind === 'burn' ? ('burn' as const) : ('pool' as const)),
      share: whole !== null ? share6(e.balance, whole) : null,
    }));

  return {
    token,
    countedSupply: circulating.toString(),
    holderCount:
      totals.holders !== null
        ? Math.max(0, totals.holders - entries.filter(isSetAside).length)
        : null,
    top: holders.slice(0, topN),
    concentration: {
      top1: counted[0]?.share ?? 0,
      top10: counted.slice(0, 10).reduce((sum, h) => sum + h.share, 0),
    },
    pooledShare: whole !== null ? share6(setAside, whole) : null,
    setAside: setAsideList,
    distinctTraders: null,
  };
}

/**
 * Récupère la distribution des détenteurs.
 *
 * Sans clé, le module ne lève pas : il renvoie `unavailable` avec une note.
 * Le brief veut qu'un échec partiel n'empêche pas l'analyse — c'est à l'agent
 * de dire que cette source manque, pas au pipeline de renoncer.
 */
export async function fetchHolderDistribution(
  token: string,
  options: FetchHoldersOptions = {},
): Promise<HolderDistribution> {
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();

  if (!options.apiKey) {
    return {
      completeness: 'unavailable',
      sources: [
        {
          name: 'blockscout',
          fetchedAt,
          note: 'no API key — Blockscout returns 402 without a key, including on the free tier',
        },
      ],
      data: emptyDistribution(token),
    };
  }

  const maxPages = options.maxPages ?? 8;
  // The count and the supply are a bonus: their failure leaves the list as is.
  const totalsRequest = requestJson<BlockscoutToken>(
    tokenUrl(token, options.apiKey, options.baseUrl),
    { source: 'blockscout', budget: options.budget, retries: 0 },
  ).then(readTotals, (error: unknown): TokenTotals => {
    log.warn('totaux Blockscout indisponibles', { token, error: String(error) });
    return { holders: null, supply: null };
  });
  const collected: BlockscoutHolder[] = [];
  let params: Record<string, string | number> = { apikey: options.apiKey };
  let pages = 0;
  let more = false;

  while (pages < maxPages) {
    const page = await requestJson<BlockscoutHoldersPage>(
      holdersUrl(token, params, options.baseUrl),
      { source: 'blockscout', budget: options.budget },
    );
    if (!Array.isArray(page.items)) {
      throw new IncompleteDataError('blockscout', 'response missing the `items` field');
    }
    collected.push(...page.items);
    pages += 1;

    if (!page.next_page_params) break;
    params = { apikey: options.apiKey, ...page.next_page_params };
    more = true;
    if (pages >= maxPages) break;
  }

  const truncated = more && pages >= maxPages;
  const totals = await totalsRequest;
  const data = computeDistribution(token, collected, options, {
    holders: totals.holders,
    // A complete list is its own base; the supply only corrects a cut one.
    supply: truncated ? totals.supply : null,
    complete: !truncated,
  });

  return {
    completeness: truncated ? 'partial' : 'full',
    sources: [
      {
        name: 'blockscout',
        fetchedAt,
        ...(truncated ? { note: `${maxPages} pages read — remaining holders not covered` } : {}),
      },
    ],
    data,
  };
}

function readTotals(body: BlockscoutToken): TokenTotals {
  const count = Number(body?.holders_count);
  return {
    holders: Number.isInteger(count) && count >= 0 ? count : null,
    supply: parseSupply(body?.total_supply),
  };
}

function parseSupply(raw: string | null | undefined): bigint | null {
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function emptyDistribution(token: string): HolderDistributionData {
  return {
    token,
    countedSupply: '0',
    holderCount: null,
    top: [],
    concentration: { top1: 0, top10: 0 },
    distinctTraders: null,
  };
}
