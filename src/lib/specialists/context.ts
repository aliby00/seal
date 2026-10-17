import type { TokenReport } from '../contracts';
import { readOnchainFacts, readTokenMetas } from '../chain/facts';
import { readHook } from '../chain/hooks';
import {
  findMarketsOf,
  NATIVE,
  pickMarket,
  type IndexedMarket,
  type MarketIndex,
} from '../chain/pools';
import type { RpcClient } from '../chain/rpc';
import { indexer } from '../indexer/client';
import { fundingFacts, fundingNetwork } from '../indexer/merge';
import { classifyFunding, findFirstFunding } from '../chain/funding';
import { log } from '../logger';
import type { FundingFacts, SpecialistContext } from './types';

/** Profondeur de recherche du marché v4 d'un token : ~35 jours, comme l'historique créateur. */
export const MARKET_LOOKBACK_BLOCKS = 30_000_000;

/**
 * Rassemble ce dont les spécialistes ont besoin, à partir du rapport déjà
 * collecté. Chaque lecture peut échouer seule et le spécialiste concerné
 * répondra `unknown` en le disant — jamais l'analyse entière.
 */
export async function gatherContext(
  rpc: RpcClient,
  token: string,
  report: TokenReport | undefined,
  index?: MarketIndex,
): Promise<SpecialistContext> {
  const context: SpecialistContext = {
    token: token.toLowerCase(),
    ...(report ? { report } : {}),
    ...(index ? { index } : {}),
  };

  // The creator named by the launch record: the market they opened is the
  // token's market, whoever else opened one beside it.
  const reported =
    report && report.creator.completeness !== 'unavailable' ? report.creator.data.creator : null;

  let market: IndexedMarket | null;
  try {
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
    market = await pickMarket(rpc, found, { creator: reported, latestBlock: latest });
  } catch (error) {
    log.warn('marché v4 introuvable', { token, error: String(error) });
    market = index?.ofToken(token)[0] ?? null;
  }
  context.market = market;

  if (market && market.name === undefined) {
    const meta = await readTokenMetas(rpc, [market.token]).catch(() => undefined);
    const m = meta?.get(market.token);
    // A copy: the market comes from an index shared by every request on this
    // instance, and writing into it made one user's results depend on others'.
    market = { ...market, name: m?.name ?? null, symbol: m?.symbol ?? null };
    context.market = market;
  }

  const hook = market && market.hook !== NATIVE ? market.hook : null;
  context.hook = hook ? readHook(hook) : null;

  // Le créateur vient du rapport pons s'il existe ; sinon c'est l'expéditeur
  // de la transaction qui a créé le marché v4 — une transaction a toujours un
  // expéditeur humain (EOA), même quand elle passe par un routeur.
  let creator = reported;
  if (!creator && market) {
    const tx = await rpc
      .call<{ from?: string } | null>('eth_getTransactionByHash', [market.transactionHash])
      .catch(() => null);
    creator = tx?.from?.toLowerCase() ?? null;
  }
  context.creator = creator;
  try {
    const facts = await readOnchainFacts(rpc, { hook, creator, token: context.token });
    context.hookCode = facts.hookCode;
    context.creatorNonce = facts.creatorNonce;
    context.tokenBeacon = facts.tokenBeacon;
  } catch (error) {
    log.warn('faits on-chain illisibles', { token, error: String(error) });
    context.hookCode = null;
    context.creatorNonce = null;
    context.tokenBeacon = null;
  }
  context.funding = await gatherFunding(rpc, token, creator);
  if (context.funding === undefined) delete context.funding;
  return context;
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
  // effective funder in the indexer's records.
  const unprofiled =
    funding.funderKind === 'unknown' ||
    (funding.funderKind === 'tool' && (funding.originKind ?? 'unknown') === 'unknown');
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
