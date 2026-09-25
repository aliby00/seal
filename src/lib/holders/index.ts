import type { Holder, HolderDistribution, HolderDistributionData } from '../contracts';
import { IncompleteDataError } from '../errors';
import { requestJson, type RequestBudget } from '../http';
import { holdersUrl, type BlockscoutHolder, type BlockscoutHoldersPage } from './blockscout';

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
  /** Nombre de pages à parcourir. Le tier gratuit est à 5 req/s. */
  maxPages?: number;
  topN?: number;
  now?: () => Date;
};

export function classifyHolder(
  address: string,
  isContract: boolean,
  poolAddress?: string,
): Holder['kind'] {
  const lower = address.toLowerCase();
  if (poolAddress && lower === poolAddress.toLowerCase()) return 'pool';
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
): HolderDistributionData {
  const topN = options.topN ?? 20;

  const entries = raw
    .map((item) => {
      const address = item.address?.hash ?? '';
      const balance = BigInt(item.value ?? '0');
      return {
        address,
        balance,
        kind: classifyHolder(address, item.address?.is_contract ?? false, options.poolAddress),
      };
    })
    .filter((entry) => entry.address !== '');

  const circulating = entries
    .filter((entry) => entry.kind !== 'pool' && entry.kind !== 'burn')
    .reduce((sum, entry) => sum + entry.balance, 0n);

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
    totalSupply: circulating.toString(),
    holderCount: null,
    top: holders.slice(0, topN),
    concentration: {
      top1: counted[0]?.share ?? 0,
      top10: counted.slice(0, 10).reduce((sum, h) => sum + h.share, 0),
    },
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
          note: 'aucune clé API — Blockscout renvoie 402 sans clé, même sur le tier gratuit',
        },
      ],
      data: emptyDistribution(token),
    };
  }

  const maxPages = options.maxPages ?? 3;
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
      throw new IncompleteDataError('blockscout', 'champ `items` absent de la réponse');
    }
    collected.push(...page.items);
    pages += 1;

    if (!page.next_page_params) break;
    params = { apikey: options.apiKey, ...page.next_page_params };
    more = true;
    if (pages >= maxPages) break;
  }

  const data = computeDistribution(token, collected, options);
  const truncated = more && pages >= maxPages;

  return {
    completeness: truncated ? 'partial' : 'full',
    sources: [
      {
        name: 'blockscout',
        fetchedAt,
        ...(truncated
          ? { note: `${maxPages} pages parcourues — détenteurs suivants non couverts` }
          : {}),
      },
    ],
    data,
  };
}

function emptyDistribution(token: string): HolderDistributionData {
  return {
    token,
    totalSupply: '0',
    holderCount: null,
    top: [],
    concentration: { top1: 0, top10: 0 },
    distinctTraders: null,
  };
}
