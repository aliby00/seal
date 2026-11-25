import type { Finding, Specialist, SpecialistId } from './types';

/**
 * The ten questions SEAL asks of every token.
 *
 * TODO-SOLANA: the answers were written for Robinhood Chain (Uniswap v4
 * hooks, the SEAL indexer, Blockscout funding, EVM nonces) and went away with
 * the EVM reads. Until they are rewritten on the Solana report (another
 * change does it), every question keeps its id, title and wording for the
 * screen and the agent composer, and answers `unknown` with the limit below:
 * nothing is said that was not read. The questions about trading rules
 * (hooks) have no Solana equivalent as worded; their rewrite decides what
 * they become (transfer hooks, token powers, pool types).
 */

/** The limit every question gives until it is rewritten for Solana. */
export const NOT_PORTED = 'this question is not yet answered for Solana tokens';

function pending(id: SpecialistId, title: string, question: string): Specialist {
  return {
    id,
    title,
    question,
    // TODO-SOLANA: answer from `context.report` (the Solana TokenReport).
    run: (): Finding => ({ specialist: id, signal: 'unknown', facts: [], limits: [NOT_PORTED] }),
  };
}

export const CATALOG: Record<SpecialistId, Specialist> = {
  'code-reuse': pending(
    'code-reuse',
    'Code Reuse',
    'Have this market’s trading rules (hook) already been used by other markets?',
  ),
  'wallet-age': pending(
    'wallet-age',
    'Wallet Age',
    'Did the creator’s wallet exist before this launch?',
  ),
  'funding-trace': pending(
    'funding-trace',
    'Funding Trace',
    'Who paid for the creator’s wallet, and did they fund other creators?',
  ),
  'name-clone': pending(
    'name-clone',
    'Name Clone',
    'Does the token borrow a name it does not own, or reuse an earlier token’s name?',
  ),
  'holder-spread': pending(
    'holder-spread',
    'Holder Spread',
    'How much of the supply sits in a few wallets?',
  ),
  'creator-history': pending(
    'creator-history',
    'Creator History',
    'What happened to the creator’s previous tokens?',
  ),
  'sell-path': pending(
    'sell-path',
    'Sell Path',
    'Can holders sell, and can the trading rules (hook) stand in the way?',
  ),
  'volume-reality': pending(
    'volume-reality',
    'Volume Reality',
    'Does the trading come from many people, or from a few addresses going back and forth?',
  ),
  'liquidity-move': pending(
    'liquidity-move',
    'Liquidity Move',
    'Has liquidity been taken out, and can the trading rules (hook) touch withdrawals?',
  ),
  'rule-change': pending(
    'rule-change',
    'Rule Change',
    'Can the trading rules (hook) be rewritten after people have bought?',
  ),
};
