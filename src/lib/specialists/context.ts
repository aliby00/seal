import type { TokenReport } from '../contracts';
import { readOnchainFacts, readTokenMetas } from '../chain/facts';
import { readHook } from '../chain/hooks';
import {
  findMarketsById,
  findMarketsOf,
  NATIVE,
  pickMarket,
  type IndexedMarket,
  type MarketIndex,
} from '../chain/pools';
import type { RpcClient } from '../chain/rpc';
import { indexer } from '../indexer/client';
import { fundingFacts, fundingNetwork } from '../indexer/merge';
import { isDelegatedWallet } from '../chain/code';
import { classifyFunder } from '../chain/funder-kind';
import { classifyFunding, findFirstFunding } from '../chain/funding';
import { log } from '../logger';
import type { ListedPool } from '../contracts';
import { mainPool, meaningfulPools } from '../market';
import type { FundingFacts, HookUse, PoolRules, SpecialistContext } from './types';

/** Profondeur de recherche du marché v4 d'un token : ~35 jours, comme l'historique créateur. */
export const MARKET_LOOKBACK_BLOCKS = 30_000_000;

/**
 * Rassemble ce dont les spécialistes ont besoin, à partir du rapport déjà
 * collecté. Chaque lecture peut échouer seule et le spécialiste concerné
 * répondra `unknown` en le disant — jamais l'analyse entière.
 */
/** The token's v4 markets, found before the report is ready: they do not depend on it. */
export type MarketDiscovery = { latest: number; found: IndexedMarket[] };

/**
 * Finds the token's v4 markets: in the recent index, else over the last ~35
 * days of `Initialize` events. Needs nothing from the report, so the analysis
 * starts it alongside the collection (MEME: the questions ran out of time
 * waiting for both, one after the other).
 */
export async function discoverMarkets(
  rpc: RpcClient,
  token: string,
  index?: MarketIndex,
): Promise<MarketDiscovery> {
  const latest = Number(await rpc.call<string>('eth_blockNumber', []));
  const indexed = index?.ofToken(token) ?? [];
  const found =
    indexed.length > 0
      ? indexed
      : (
          await findMarketsOf(rpc, token, {
            fromBlock: Math.max(0, latest - MARKET_LOOKBACK_BLOCKS),
            toBlock: latest,
          })
        ).map((m) => ({ ...m, token: token.toLowerCase() }));
  return { latest, found };
}

export async function gatherContext(
  rpc: RpcClient,
  token: string,
  report: TokenReport | undefined,
  index?: MarketIndex,
  discovery?: Promise<MarketDiscovery>,
): Promise<SpecialistContext> {
  const context: SpecialistContext = {
    token: token.toLowerCase(),
    ...(report ? { report } : {}),
    ...(index ? { index } : {}),
  };
  // Every lookup that failed is named: an answer it leaves unmeasured is a partial report.
  const unread: string[] = [];
  context.unread = unread;

  // The creator named by the launch record: the market they opened is the
  // token's market, whoever else opened one beside it.
  const reported =
    report && report.creator.completeness !== 'unavailable' ? report.creator.data.creator : null;
  // Who funded a creator already known does not wait for the market: both
  // are read at once.
  const fundingOfReported = reported
    ? gatherFunding(rpc, token, reported).catch((error: unknown) => {
        log.warn('financement non lu', { token, error: String(error) });
        unread.push('who funded the creator');
        return undefined;
      })
    : undefined;

  // The market whose rules are read is the main pool, the most liquid one
  // listed, and every other pool with liquidity is weighed beside it. Taking
  // whichever v4 market the recent index held read BOOMER, Wheel Smith and
  // WORM from a small hookless pool beside a main pool with a hook (staging,
  // 18/10/2026), and ASTEROID from a pool opened by someone else.
  const listed = report?.market.data;
  const main = mainPool(listed);
  context.mainPool = main ? poolRules(main) : null;
  context.otherPools = meaningfulPools(listed).map(poolRules);

  let market: IndexedMarket | null;
  if (main && main.version !== 'v4') {
    // A v2/v3 pair: no Uniswap v4 rules on the main pool.
    market = null;
  } else if (main) {
    market = await mainMarket(rpc, token, main, discovery);
    if (!market) {
      context.mainRulesUnread = true;
      unread.push('the main pool’s trading rules');
    }
  } else {
    try {
      const { latest, found } = await (discovery ?? discoverMarkets(rpc, token, index));
      market = await pickMarket(rpc, found, { creator: reported, latestBlock: latest });
    } catch (error) {
      log.warn('marché v4 introuvable', { token, error: String(error) });
      market = index?.ofToken(token)[0] ?? null;
    }
  }
  context.market = market;

  if (market && market.name === undefined) {
    const meta = await readTokenMetas(rpc, [market.token]).catch(() => {
      unread.push('the token’s name');
      return undefined;
    });
    const m = meta?.get(market.token);
    // A copy: the market comes from an index shared by every request on this
    // instance, and writing into it made one user's results depend on others'.
    market = { ...market, name: m?.name ?? null, symbol: m?.symbol ?? null };
    context.market = market;
  }

  const hook = market && market.hook !== NATIVE ? market.hook : null;
  context.hook = hook ? readHook(hook) : null;
  // How many markets run on that hook, over the indexer's whole history:
  // a recent window gave each of four tokens on 0xe5e7… "1 market".
  const hookUse = hook ? hookUseOf(hook) : Promise.resolve(undefined);

  // Le créateur vient du rapport pons s'il existe ; sinon c'est l'expéditeur
  // de la transaction qui a créé le marché v4 — une transaction a toujours un
  // expéditeur humain (EOA), même quand elle passe par un routeur.
  let creator = reported;
  if (!creator && market) {
    const tx = await rpc
      .call<{ from?: string } | null>('eth_getTransactionByHash', [market.transactionHash])
      .catch(() => {
        unread.push('who opened the market');
        return null;
      });
    creator = tx?.from?.toLowerCase() ?? null;
  }
  context.creator = creator;
  const [facts, funding] = await Promise.all([
    readOnchainFacts(rpc, { hook, creator, token: context.token }).catch((error: unknown) => {
      log.warn('faits on-chain illisibles', { token, error: String(error) });
      unread.push('the hook’s code and the creator’s wallet');
      return null;
    }),
    fundingOfReported && creator === reported
      ? fundingOfReported
      : gatherFunding(rpc, token, creator),
  ]);
  context.hookCode = facts?.hookCode ?? null;
  context.creatorNonce = facts?.creatorNonce ?? null;
  context.tokenBeacon = facts?.tokenBeacon ?? null;
  context.funding = funding;
  if (context.funding === undefined) delete context.funding;
  const use = await hookUse;
  if (use !== undefined) context.hookUse = use;
  return context;
}

/**
 * The main pool and the other pools as the collection read them, without a
 * request: what the market questions can still answer when their own
 * lookups ran out of time.
 */
export function fromReport(
  token: string,
  report: TokenReport,
): Pick<SpecialistContext, 'mainPool' | 'otherPools' | 'market' | 'hook'> {
  const listed = report.market.data;
  const main = mainPool(listed);
  if (!main) return {};
  const out: Pick<SpecialistContext, 'mainPool' | 'otherPools' | 'market' | 'hook'> = {
    mainPool: poolRules(main),
    otherPools: meaningfulPools(listed).map(poolRules),
  };
  if (main.version !== 'v4') {
    out.market = null;
    out.hook = null;
  } else if (main.v4) {
    out.market = { id: main.id, ...main.v4, token: token.toLowerCase() };
    out.hook = main.v4.hook !== NATIVE ? readHook(main.v4.hook) : null;
  }
  return out;
}

function poolRules(pool: ListedPool): PoolRules {
  return {
    id: pool.id,
    version: pool.version,
    liquidityUsd: pool.liquidityUsd,
    hook: pool.version === 'v4' ? (pool.v4 ? pool.v4.hook : undefined) : null,
  };
}

/**
 * The main pool as a v4 market: from what the collection read of it, else
 * from the markets found for the token, else from its own `Initialize`.
 * `null` when none of them could be read.
 */
async function mainMarket(
  rpc: RpcClient,
  token: string,
  main: ListedPool,
  discovery: Promise<MarketDiscovery> | undefined,
): Promise<IndexedMarket | null> {
  const own = token.toLowerCase();
  if (main.v4) return { id: main.id, ...main.v4, token: own };
  const found = await (discovery ?? Promise.resolve(undefined)).catch(() => undefined);
  const hit = found?.found.find((m) => m.id === main.id);
  if (hit) return { ...hit, token: own };
  try {
    const latest = found?.latest ?? Number(await rpc.call<string>('eth_blockNumber', []));
    const { markets } = await findMarketsById(
      rpc,
      [{ id: main.id, createdAt: main.createdAt ?? null }],
      latest,
    );
    const m = markets[0];
    return m ? { ...m, token: own } : null;
  } catch (error) {
    log.warn('pool principal illisible', { token, error: String(error) });
    return null;
  }
}

/** Markets on a hook, from the indexer; `null` when it did not answer, `undefined` with none configured. */
async function hookUseOf(hook: string): Promise<HookUse | null | undefined> {
  const ix = indexer();
  if (!ix?.hook) return undefined;
  const answer = await ix.hook(hook).catch(() => undefined);
  if (!answer || answer.indexedTo <= 0) return null;
  return { markets: answer.markets, pairs: answer.pairs, indexedTo: answer.indexedTo };
}

/** Whether a funder classified as a service is in fact a wallet delegating under EIP-7702. */
async function delegated(rpc: RpcClient, address: string): Promise<boolean> {
  const code = await rpc.call<string>('eth_getCode', [address, 'latest']).catch(() => null);
  return isDelegatedWallet(code);
}

/**
 * Who first funded the creator, what that funder is, and the creators linked
 * through it.
 *
 * From the indexer first. While it has not read this creator, or not yet
 * profiled its funder, Blockscout is asked directly, so the first analysis
 * does not wait: the first funding, then the funder's profile (and the
 * sender behind a batch-sending tool, by the RPC). The other creators and
 * the network come from the indexer's records only. `undefined` = not
 * looked up; `null` = looked up, no incoming funding found.
 */
export async function gatherFunding(
  rpc: RpcClient,
  token: string,
  creator: string | null,
): Promise<FundingFacts | null | undefined> {
  if (!creator) return undefined;
  const ix = indexer();
  const apiKey = process.env.BLOCKSCOUT_API_KEY;
  let funding: FundingFacts | null | undefined = ix
    ? fundingFacts(await ix.creator(creator))
    : undefined;

  if (funding === undefined && apiKey) {
    try {
      const first = await findFirstFunding(creator, apiKey);
      funding =
        first === null
          ? null
          : {
              funder: first.funder,
              funderKind: 'unknown',
              txHash: first.txHash,
              otherCreatorsFunded: 0,
            };
    } catch (error) {
      log.warn('financement illisible', { token, error: String(error) });
    }
  }
  if (!funding) return funding;

  // Not profiled by the indexer yet: profiled here, and grouped by the
  // effective funder in the indexer's records. So is a funder the indexer
  // stored as a contract while its code is an EIP-7702 delegation: Blockscout
  // flags such a wallet as a contract (GNRG's and AI's funders, nonce 138 and
  // 416), and the indexer's row may predate the code check.
  const wallet7702 = funding.funderKind === 'service' && (await delegated(rpc, funding.funder));
  const unprofiled =
    funding.funderKind === 'unknown' ||
    (funding.funderKind === 'tool' && (funding.originKind ?? 'unknown') === 'unknown') ||
    wallet7702;
  if (wallet7702 && !apiKey) {
    // No profile to read again: the indexer's count decides, as for any wallet.
    funding = {
      ...funding,
      funderKind: classifyFunder({
        address: funding.funder,
        isContract: false,
        name: funding.funderName ?? null,
        txCount: funding.funderTxCount ?? null,
        tags: [],
      }),
    };
  }
  if (unprofiled && apiKey) {
    try {
      const c = await classifyFunding(rpc, funding, apiKey);
      funding = {
        ...funding,
        funderKind: c.funderKind,
        funderName: c.funderName,
        funderTxCount: c.funderTxCount,
        ...(c.funderKind === 'tool'
          ? {
              origin: c.origin ?? null,
              originKind: c.originKind ?? null,
              originTxCount: c.originTxCount ?? null,
            }
          : {}),
        otherCreatorsFunded: 0,
        ...(ix ? {} : { otherCreatorsChecked: false }),
      };
      if (c.effectiveKind === 'wallet' && c.effective && ix) {
        const funded = await ix.funder(c.effective);
        const others = new Set(
          (funded?.creators ?? [])
            .map((r) => r.creator.toLowerCase())
            .filter((r) => r !== creator.toLowerCase()),
        );
        funding.otherCreatorsFunded = others.size;
      }
    } catch (error) {
      log.warn('financeur non profilé', { token, error: String(error) });
    }
  }

  const effectiveKind =
    funding.funderKind === 'tool' ? (funding.originKind ?? 'unknown') : funding.funderKind;
  if (effectiveKind === 'wallet' && ix) {
    const network = fundingNetwork(await ix.network(creator));
    if (network) funding.network = network;
  }
  return funding;
}
