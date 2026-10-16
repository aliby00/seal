import type { Sourced } from './completeness';

/**
 * Where the supply went in the first minutes of a token's life, move by move.
 *
 * Every move is a fact read from the token's own `Transfer` events. Nothing is
 * labelled sniper, insider or bundle: a wallet that bought in the launch block
 * is shown as having bought in the launch block, and the reader judges.
 */
export type LaunchMoveKind =
  /** Supply created and handed to its first holder. */
  | 'mint'
  /** Supply passed from one holder to another, outside any pool. */
  | 'allocation'
  /** Tokens taken out of a pool: a purchase. */
  | 'buy'
  /** Tokens put back into a pool: a sale. */
  | 'sell';

export type LaunchMove = {
  kind: LaunchMoveKind;
  /** Seconds since the launch block. */
  seconds: number;
  /** Blocks since the launch block (0 = the launch block itself). */
  block: number;
  /** The address the move is about: who received, bought or sold. */
  actor: string;
  /** The other side: the sender, or the pool. */
  counterparty: string;
  actorKind: 'wallet' | 'contract' | 'pool' | 'burn';
  /** Part of the supply moved, from 0 to 1. */
  share: number;
  actorIsCreator: boolean;
  counterpartyIsCreator: boolean;
  /** Part of the supply the actor holds today, `null` when it could not be read. */
  heldNow: number | null;
  transaction: string;
};

export type LaunchReplayData = {
  token: string;
  launchBlock: number;
  launchedAt: string | null;
  /** Length of the window read, in seconds. */
  windowSeconds: number;
  /** Supply the shares are measured against. */
  supply: string;
  moves: LaunchMove[];
  /** Moves in the window, including any beyond those listed. */
  movesInWindow: number;
};

export type LaunchReplay = Sourced<LaunchReplayData>;
