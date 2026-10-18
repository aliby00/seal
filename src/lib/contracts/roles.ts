/**
 * What an address is to a token, read on chain: never "a contract" when the
 * chain says more. A holder of 28 % that is a vesting lock is not a person
 * with 28 %; a wallet that received 25 % at launch from a launchpad is the
 * launchpad's capital-formation wallet, not an insider.
 *
 * Every role is recognised from what the address answers (its getters, its
 * code) or from a launchpad's own configuration; `evidence` says which, so a
 * reader can check it.
 */
export type AddressRoleKind =
  /** A V2 pair or V3 pool trading the token. */
  | 'pool'
  /** A launchpad's bonding curve. */
  | 'curve'
  /** A launchpad's own contract. */
  | 'launchpad'
  /** A launchpad's wallet that receives part of the supply at launch and hands it out. */
  | 'distributor'
  /** A launchpad's wallet that sells an allocation over time for the project (Virtuals' ACF). */
  | 'capital-formation'
  /** A vesting or lock contract: what it holds unlocks on a schedule. */
  | 'vesting'
  /** A contract that sends tokens to many addresses in one go. */
  | 'batch-sender'
  /** A smart-contract wallet (ERC-4337 account): a person's or a service's account. */
  | 'smart-wallet';

/** One unlocking schedule of a vesting lock, as shares of the whole supply. */
export type VestingSchedule = {
  /** Who can claim it; `null` when unread. */
  beneficiary: string | null;
  total: number;
  claimed: number;
  /** Unlocked so far, claimed or not. */
  unlocked: number;
  /** When the first part unlocks, and when the last does. */
  startsAt: string;
  endsAt: string;
  /** How many unlocks, all steps together; 0 when it unlocks continuously. */
  steps: number;
};

export type VestingLock = {
  /** Which lock product: recognised from its own `version()`. */
  provider: 'TokenTable';
  version: string;
  /** Who manages the lock, and whether they may still cancel schedules or withdraw the deposit. */
  owner: string | null;
  cancelable: boolean | null;
  withdrawable: boolean | null;
  schedules: VestingSchedule[];
  /** Still locked today, share of the whole supply. */
  locked: number;
  /** The next unlock still to come, and the last one. */
  nextUnlockAt: string | null;
  fullyUnlockedAt: string | null;
};

export type NamedAddress = {
  address: string;
  kind: AddressRoleKind;
  /** How the report names it: "Virtuals’ capital-formation wallet (ACF)". */
  name: string;
  /** One sentence on what it does with the token, for a person. */
  detail?: string;
  /** Whether what it holds can be sold freely today: a lock's tokens cannot. */
  tradable: boolean;
  /** Which launchpad it belongs to, when it is one's. */
  launchpad?: string;
  lock?: VestingLock;
  /** What was read to name it. */
  evidence: string;
};
