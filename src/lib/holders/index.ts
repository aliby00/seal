import type { Holder, HolderDistribution, HolderDistributionData } from '../contracts';
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
};

/** The v4 PoolManager holds every v4 market's liquidity; it is never a holder. */
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

export function classifyHolder(
  address: string,
  isContract: boolean,
  poolAddress?: string,
  liquidity: readonly string[] = [],
): Holder['kind'] {
  const lower = address.toLowerCase();
  if (poolAddress && lower === poolAddress.toLowerCase()) return 'pool';
  if (lower === POOL_MANAGER || liquidity.some((a) => a.toLowerCase() === lower)) return 'pool';
  if (BURN_ADDRESSES.has(lower)) return 'burn';
  return isContract ? 'contract' : 'wallet';
}

/**
 * Calcule les parts sur l'offre **hors pool et hors burn**.
 *
 * Sans cette exclusion, le pool ressort systématiquement comme détenteur
 * majoritaire et la concentration ne veut plus rien dire : c'est la liquidité,
 * pas une position d'un acteur.
 */
export function computeDistribution(
  token: string,
  raw: BlockscoutHolder[],
  options: FetchHoldersOptions = {},
  totals: TokenTotals = { holders: null, supply: null },
): HolderDistributionData {
  const topN = options.topN ?? 20;

  const entries = raw
    .map((item) => {
      const address = item.address?.hash ?? '';
      const balance = BigInt(item.value ?? '0');
      return {
        address,
        balance,
        kind: classifyHolder(
          address,
          item.address?.is_contract ?? false,
          options.poolAddress,
          options.liquidityAddresses,
        ),
      };
    })
    .filter((entry) => entry.address !== '');

  const listed = entries
    .filter((entry) => entry.kind !== 'pool' && entry.kind !== 'burn')
    .reduce((sum, entry) => sum + entry.balance, 0n);
  const setAside = entries
    .filter((entry) => entry.kind === 'pool' || entry.kind === 'burn')
    .reduce((sum, entry) => sum + entry.balance, 0n);
  // When the list is cut, the holders read are not the whole supply: shares
  // measured against them alone would overstate every one of them. The total
  // supply, less the pools and burn addresses, is the true base.
  const fromSupply = totals.supply !== null ? totals.supply - setAside : null;
  const circulating = fromSupply !== null && fromSupply > listed ? fromSupply : listed;

  const holders: Holder[] = entries
    .map((entry) => ({
      address: entry.address,
      balance: entry.balance.toString(),
      share:
        circulating > 0n && entry.kind !== 'pool' && entry.kind !== 'burn'
          ? Number((entry.balance * 1_000_000n) / circulating) / 1_000_000
          : 0,
      kind: entry.kind,
    }))
    .sort((a, b) => b.share - a.share);

  const counted = holders.filter((h) => h.kind === 'wallet' || h.kind === 'contract');

  return {
    token,
    countedSupply: circulating.toString(),
    holderCount:
      totals.holders !== null
        ? Math.max(
            0,
            totals.holders - entries.filter((e) => e.kind === 'pool' || e.kind === 'burn').length,
          )
        : null,
    top: holders.slice(0, topN),
    concentration: {
      top1: counted[0]?.share ?? 0,
      top10: counted.slice(0, 10).reduce((sum, h) => sum + h.share, 0),
    },
    pooledShare:
      totals.supply !== null && totals.supply > 0n
        ? Number((setAside * 1_000_000n) / totals.supply) / 1_000_000
        : null,
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

  const maxPages = options.maxPages ?? 3;
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
