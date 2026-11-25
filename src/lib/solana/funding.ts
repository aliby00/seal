import {
  attempt,
  failureNote,
  findCreation,
  limitRpc,
  marketsIn,
  notAnAddressNote,
  readMint,
  readWalletOnToken,
  signersOf,
  solChange,
  source,
  systemTransfers,
  type ReadLimits,
} from './creator';
import { isSolanaAddress } from './address';
import type { SolanaFundedWallet, SolanaLinkedWallets, SolanaSolTransfer } from './creator-types';
import { associatedTokenAddress, INCINERATOR, knownProgram, SYSTEM_PROGRAM } from './programs';
import { collectSignatures, type SignatureInfo, type SolanaRpc } from './rpc';

/**
 * The wallets the chain links to a token's creator: who first sent it SOL,
 * which wallets it sent SOL to around the launch, and what those sold of the
 * token. The same question the EVM read asks of Blockscout (chain/funding.ts),
 * answered from the creator's own transactions.
 *
 * Only transfers are links: each comes with the transaction that shows it.
 * Who controls an address is never shown by the chain, and never said.
 */

/** Pages of the creator's signatures listed: its first funding needs its first transaction. */
export const FUNDING_SIGNATURE_PAGES = 2;
/** Its oldest transactions read for the first SOL received. */
export const FUNDING_TRANSACTIONS = 5;
/** Its transactions read around the launch. */
export const WINDOW_TRANSACTIONS = 10;
/** The window around the launch: from a day before to an hour after. */
export const WINDOW_BEFORE_S = 86_400;
export const WINDOW_AFTER_S = 3_600;
/** Funded wallets whose trades of the token are read, the best funded first. */
export const FUNDED_WALLETS_READ = 3;
/** Transactions of each funded wallet's token accounts read. */
export const FUNDED_WALLET_TRANSACTIONS = 4;

export type LinkedWalletsOptions = ReadLimits & {
  /**
   * Unix seconds of the launch, or their promise: the creation the launch
   * replay finds while the creator's first funding is read. Read from the
   * mint's creation when not given, or when it comes to `null`.
   */
  launchTime?: number | null | PromiseLike<number | null>;
  signaturePages?: number;
  fundingTransactions?: number;
  windowTransactions?: number;
  windowBeforeS?: number;
  windowAfterS?: number;
  maxWallets?: number;
  walletTransactions?: number;
};

function transfer(
  t: { from: string; to: string; lamports: bigint },
  how: SolanaSolTransfer['how'],
  s: SignatureInfo,
  slot: number,
  blockTime: number | null,
): SolanaSolTransfer {
  return {
    from: t.from,
    to: t.to,
    lamports: t.lamports.toString(),
    how,
    signature: s.signature,
    slot,
    blockTime,
  };
}

/**
 * The first SOL `wallet` received: the oldest transaction it did not sign in
 * which its balance rose (`signatures` newest first, as the node lists them).
 * The sender is the source of a System Program transfer to it when the
 * transaction has one, else the transaction's fee payer. Measured on
 * D234v6Hg… (24/11/2026): its first transaction, signed by 16hA8T…, raised
 * it from 0 to 5.63 SOL with no transfer instruction (a wrapped-SOL account
 * closed to it); the first System transfer to it came later, 1 lamport of
 * spam sent to 19 wallets at once.
 */
export async function findFirstFunding(
  rpc: SolanaRpc,
  wallet: string,
  signatures: readonly SignatureInfo[],
  complete: boolean,
  max = FUNDING_TRANSACTIONS,
): Promise<{
  funding: SolanaSolTransfer | null;
  state: 'found' | 'none-seen' | 'not-reached';
  note?: string;
}> {
  if (!complete) {
    return {
      funding: null,
      state: 'not-reached',
      note: `the creator has more than ${signatures.length} transactions: its first funding was not reached`,
    };
  }
  const oldest = [...signatures].reverse().filter((s) => s.err === null);
  let read = 0;
  for (const s of oldest.slice(0, max)) {
    const got = await attempt(() => rpc.getTransaction(s.signature));
    if (!got.ok) {
      return {
        funding: null,
        state: 'not-reached',
        note: `funding not read: ${failureNote(got.error)}`,
      };
    }
    read += 1;
    const tx = got.value;
    if (!tx || tx.meta?.err || signersOf(tx).includes(wallet)) continue;
    const change = solChange(tx, wallet);
    if (change <= 0n) continue;
    const blockTime = tx.blockTime ?? null;
    const direct = systemTransfers(tx)
      .filter((x) => x.to === wallet && x.from !== wallet && x.lamports > 0n)
      .sort((a, b) => (b.lamports > a.lamports ? 1 : b.lamports < a.lamports ? -1 : 0))[0];
    const funding = direct
      ? transfer(direct, 'system-transfer', s, tx.slot, blockTime)
      : transfer(
          { from: signersOf(tx)[0] ?? '', to: wallet, lamports: change },
          'balance-change',
          s,
          tx.slot,
          blockTime,
        );
    return { funding, state: 'found' };
  }
  return read < oldest.length
    ? {
        funding: null,
        state: 'not-reached',
        note: `no SOL received in the creator's first ${read} transactions`,
      }
    : { funding: null, state: 'none-seen' };
}

/** Accounts that can be a wallet: owned by the System Program, or closed since. */
function walletLike(address: string, owner: string | null): boolean {
  if (address === INCINERATOR || knownProgram(address)) return false;
  return owner === null || owner === SYSTEM_PROGRAM;
}

/**
 * Who funded `creator`, which wallets it funded around the launch of `mint`,
 * and what those sold of `mint`.
 */
export async function linkedWallets(
  creator: string,
  mint: string,
  rpc: SolanaRpc,
  options: LinkedWalletsOptions = {},
): Promise<SolanaLinkedWallets> {
  const r = limitRpc(rpc, options);
  const notes: string[] = [];
  let complete = true;
  const partial = (note: string) => {
    complete = false;
    notes.push(note);
  };
  const invalid = [creator, mint].find((a) => !isSolanaAddress(a));
  if (invalid !== undefined) {
    return {
      completeness: 'unavailable',
      sources: [source('solana-rpc', r.now(), [notAnAddressNote(invalid)])],
      data: { creator, mint, firstFunding: null, funding: 'not-reached', window: null, funded: [] },
    };
  }

  const listed = await attempt(() =>
    collectSignatures(r, creator, { maxPages: options.signaturePages ?? FUNDING_SIGNATURE_PAGES }),
  );
  if (!listed.ok) {
    return {
      completeness: 'unavailable',
      sources: [
        source('solana-rpc', r.now(), [
          `creator's transactions not listed: ${failureNote(listed.error)}`,
        ]),
      ],
      data: { creator, mint, firstFunding: null, funding: 'not-reached', window: null, funded: [] },
    };
  }
  const { signatures, complete: listedWhole } = listed.value;

  // 1. First funding.
  const funding = await findFirstFunding(
    r,
    creator,
    signatures,
    listedWhole,
    options.fundingTransactions ?? FUNDING_TRANSACTIONS,
  );
  if (funding.note) partial(funding.note);

  // 2. The launch, and the creator's transfers around it.
  const facts = await attempt(() => readMint(r, mint));
  if (!facts.ok) partial(`mint not read: ${failureNote(facts.error)}`);
  const mintFacts = facts.ok ? facts.value : null;
  let launch = (await options.launchTime) ?? null;
  if (launch === null) {
    const hints = {
      accounts: mintFacts ? [associatedTokenAddress(creator, mint, mintFacts.program)] : [],
      signer: creator,
    };
    const created = await attempt(() => findCreation(r, mint, undefined, hints));
    if (created.ok) launch = created.value.creation?.blockTime ?? null;
    if (launch === null) {
      partial(
        created.ok
          ? `launch time unknown: ${created.value.note ?? 'creation not found'}`
          : `launch time unknown: ${failureNote(created.error)}`,
      );
    }
  }
  const window =
    launch === null
      ? null
      : {
          from: launch - (options.windowBeforeS ?? WINDOW_BEFORE_S),
          to: launch + (options.windowAfterS ?? WINDOW_AFTER_S),
        };
  const sent = new Map<string, SolanaSolTransfer[]>();
  if (window) {
    const oldestListed = signatures.at(-1)?.blockTime ?? null;
    if (!listedWhole && (oldestListed === null || oldestListed > window.from)) {
      partial('the creator’s transactions listed do not reach back to the start of the window');
    }
    const inWindow = signatures
      .filter((s) => s.err === null && s.blockTime !== null)
      .filter((s) => (s.blockTime as number) >= window.from && (s.blockTime as number) <= window.to)
      .sort((a, b) => a.slot - b.slot);
    const max = options.windowTransactions ?? WINDOW_TRANSACTIONS;
    let read = 0;
    for (const s of inWindow.slice(0, max)) {
      const got = await attempt(() => r.getTransaction(s.signature));
      if (!got.ok) {
        partial(`transactions around the launch read up to ${read}: ${failureNote(got.error)}`);
        break;
      }
      read += 1;
      const tx = got.value;
      if (!tx || tx.meta?.err || !signersOf(tx).includes(creator)) continue;
      // Not inside a trade: the transfers there are its fees and tips (2gzY9HcN…,
      // the creator's sale of FB5eSv7C…, paid 0.0257 SOL and 0.0001 SOL that way).
      if (marketsIn(tx).length > 0) continue;
      // Top-level only: what a program moves when it runs is its own business.
      for (const t of systemTransfers(tx)) {
        if (t.inner || t.from !== creator || t.to === creator || t.lamports <= 0n) continue;
        const list = sent.get(t.to) ?? [];
        list.push(transfer(t, 'system-transfer', s, tx.slot, tx.blockTime ?? null));
        sent.set(t.to, list);
      }
    }
    if (read < inWindow.length)
      partial(`${read} of the creator's ${inWindow.length} transactions around the launch read`);
  }

  // 3. Keep wallets: an account a program owns (a vault, a tip account) is not one.
  let recipients = [...sent.keys()];
  if (recipients.length > 0) {
    const owners = await attempt(() =>
      r.getMultipleAccounts(recipients, { dataSlice: { offset: 0, length: 0 } }),
    );
    if (owners.ok) {
      recipients = recipients.filter((a, i) => walletLike(a, owners.value[i]?.owner ?? null));
    } else {
      partial(`recipients' accounts not read: ${failureNote(owners.error)}`);
      recipients = recipients.filter((a) => walletLike(a, SYSTEM_PROGRAM));
    }
  }
  const total = (a: string) => (sent.get(a) ?? []).reduce((n, t) => n + BigInt(t.lamports), 0n);
  recipients.sort((a, b) => (total(b) > total(a) ? 1 : total(b) < total(a) ? -1 : 0));

  // 4. Their trades of the token.
  const maxWallets = options.maxWallets ?? FUNDED_WALLETS_READ;
  const funded: SolanaFundedWallet[] = [];
  for (const [i, wallet] of recipients.entries()) {
    let onToken: SolanaFundedWallet['onToken'] = null;
    if (i < maxWallets && mintFacts) {
      const { program, supply } = mintFacts;
      const read = await readWalletOnToken(
        r,
        wallet,
        mint,
        program,
        supply,
        options.walletTransactions ?? FUNDED_WALLET_TRANSACTIONS,
      );
      if (!read.complete) partial(`trades of ${wallet} read in part`);
      onToken = {
        bought: read.bought,
        sold: read.sold,
        holdsNow: read.holdsNow,
        sales: read.moves
          .filter((m) => m.kind === 'sell')
          .map((m) => ({
            signature: m.signature,
            amount: m.amount,
            share: m.share,
            blockTime: m.blockTime,
          })),
        complete: read.complete,
      };
    }
    funded.push({
      wallet,
      transfers: sent.get(wallet) ?? [],
      lamports: total(wallet).toString(),
      onToken,
    });
  }
  if (recipients.length > maxWallets) {
    partial(`trades of ${recipients.length - maxWallets} funded wallets not read`);
  }

  return {
    completeness: complete ? 'full' : 'partial',
    sources: [source('solana-rpc', r.now(), notes)],
    data: {
      creator,
      mint,
      firstFunding: funding.funding,
      funding: funding.state,
      window,
      funded,
    },
  };
}
