import type { TokenReport } from '../contracts';
import { readOnchainFacts, readTokenMetas } from '../chain/facts';
import { readHook } from '../chain/hooks';
import { findMarketsOf, NATIVE, type IndexedMarket, type MarketIndex } from '../chain/pools';
import type { RpcClient } from '../chain/rpc';
import { log } from '../logger';
import type { SpecialistContext } from './types';

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

  let market: IndexedMarket | null = index?.ofToken(token)[0] ?? null;
  if (!market) {
    try {
      const latest = Number(await rpc.call<string>('eth_blockNumber', []));
      const found = await findMarketsOf(rpc, token, {
        fromBlock: Math.max(0, latest - MARKET_LOOKBACK_BLOCKS),
        toBlock: latest,
      });
      const first = found[0];
      if (first) market = { ...first, token: token.toLowerCase() };
    } catch (error) {
      log.warn('marché v4 introuvable', { token, error: String(error) });
    }
  }
  context.market = market;

  if (market && market.name === undefined) {
    const meta = await readTokenMetas(rpc, [market.token]).catch(() => undefined);
    const m = meta?.get(market.token);
    market.name = m?.name ?? null;
    market.symbol = m?.symbol ?? null;
  }

  const hook = market && market.hook !== NATIVE ? market.hook : null;
  context.hook = hook ? readHook(hook) : null;

  // Le créateur vient du rapport pons s'il existe ; sinon c'est l'expéditeur
  // de la transaction qui a créé le marché v4 — une transaction a toujours un
  // expéditeur humain (EOA), même quand elle passe par un routeur.
  let creator =
    report && report.creator.completeness !== 'unavailable' ? report.creator.data.creator : null;
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
  // Le financement exige un indexeur : il reste `undefined` tant qu'il n'est
  // pas collecté, et le spécialiste le dit.
  return context;
}
