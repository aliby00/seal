import { TRANSFER_TOPIC, topicFor } from '../chain/behavior';
import { isContractCode } from '../chain/code';
import { getLogsBatched, type RawLog } from '../chain/logs';
import type { RpcClient } from '../chain/rpc';
import { IncompleteDataError } from '../errors';
import type { CreatorSends } from '../contracts/creator';
import {
  CREATOR_RECIPIENTS_LISTED,
  type CreatorLinks,
  type HolderDistributionData,
} from '../contracts/holders';

/**
 * Which of today's holders got their tokens from the creator.
 *
 * SEAL already reads every transfer the creator made of the token (to tell
 * its sales). Set against the holders list, they say who received from the
 * creator — directly, or through a contract the creator sent tokens to and
 * that passed them on. Measured on 18/10/2026: AGEM's creator sent its
 * 17.94 % to today's largest holder; moon's sent its 26.74 % launch buy to
 * its largest; DELTA's sent 10 % to its largest; BOOMER's sent 65.2 % and
 * 9.6 % to two contracts that airdropped them to about 1,280 addresses;
 * HYPURRT's burned 3.99 %. Each was there to read, and none was said.
 *
 * A link is a transfer, not an ownership: who controls the address is not
 * shown.
 */

/** A recipient holding at least this share of the supply is read as a possible distributor. */
const DISTRIBUTOR_MIN_SHARE = 0.01;
/** Addresses a contract must have passed tokens to, to be called a distributor. */
export const DISTRIBUTOR_MIN_RECIPIENTS = 10;
/** Contracts whose outgoing transfers are read, at most: one log query each. */
const MAX_DISTRIBUTORS_READ = 2;
/** Codes read to find them, at most: one batch. */
const MAX_CODES_READ = 5;

const BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

const share6 = (value: bigint, supply: bigint) =>
  supply > 0n ? Number((value * 1_000_000n) / supply) / 1_000_000 : 0;

/** What a contract passed on, by recipient, from its own transfers of the token. */
export function passedOn(
  logs: readonly RawLog[],
  token: string,
  from: string,
): Map<string, bigint> {
  const topic = topicFor(from);
  const out = new Map<string, bigint>();
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase() || log.topics.length !== 3) continue;
    if ((log.topics[1] ?? '').toLowerCase() !== topic) continue;
    const to = `0x${(log.topics[2] ?? '').slice(26)}`.toLowerCase();
    const raw = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
    if (BURN.has(to) || raw.length < 64) continue;
    const value = BigInt(`0x${raw.slice(0, 64)}`);
    if (value > 0n) out.set(to, (out.get(to) ?? 0n) + value);
  }
  return out;
}

/**
 * The links, from what the creator sent (`sends`), the holders read, and —
 * for the largest recipients that are contracts — what those passed on.
 * Pure but for the reads of codes and of the distributors' transfers.
 */
export async function linkCreatorToHolders(
  rpc: RpcClient,
  input: {
    token: string;
    sends: CreatorSends;
    holders: HolderDistributionData;
    supply: bigint;
    /** Addresses set aside (pools, launch contracts): never distributors. */
    setAside: ReadonlySet<string>;
    fromBlock: number;
    toBlock: number;
    /** Told when a distributor's transfers could not be read: its count is then a minimum. */
    onUnread?: (error: unknown) => void;
  },
): Promise<CreatorLinks> {
  const { token, sends, holders, supply, setAside } = input;
  const sent = new Map(sends.recipients.map((r) => [r.address.toLowerCase(), BigInt(r.value)]));
  const listed = holders.top.filter((h) => h.kind === 'wallet' || h.kind === 'contract');
  const links: CreatorLinks['holders'] = [];
  for (const h of listed) {
    const value = sent.get(h.address.toLowerCase());
    if (value !== undefined) {
      links.push({ address: h.address.toLowerCase(), share: share6(value, supply), via: null });
    }
  }

  // The largest recipients, outside pools and launch contracts: a contract
  // among them that passed tokens to many addresses is a distributor.
  const candidates = sends.recipients
    .map((r) => ({ address: r.address.toLowerCase(), value: BigInt(r.value) }))
    .filter((r) => !setAside.has(r.address) && share6(r.value, supply) >= DISTRIBUTOR_MIN_SHARE)
    .slice(0, MAX_CODES_READ);
  const distributors: CreatorLinks['distributors'] = [];
  if (candidates.length > 0) {
    // Codes that could not be read would hide a distributor: the read fails.
    const codes = await rpc.callBatch<string>(
      candidates.map((c) => ({ method: 'eth_getCode', params: [c.address, 'latest'] })),
    );
    if (codes.some((c) => !c?.ok)) {
      throw new IncompleteDataError(
        'robinhood-rpc',
        'the codes of the creator’s largest recipients could not be read',
      );
    }
    const contracts = candidates
      .filter((_, i) => codes[i]?.ok && isContractCode(codes[i]?.value as string))
      .slice(0, MAX_DISTRIBUTORS_READ);
    // One query each: this node caps a filter listing several values in one
    // position at 100,000 blocks.
    const reads = await Promise.all(
      contracts.map((c) =>
        getLogsBatched(
          rpc,
          {
            addresses: [{ address: token, fromBlock: input.fromBlock, toBlock: input.toBlock }],
            topics: [TRANSFER_TOPIC, topicFor(c.address)],
          },
          { fromBlock: input.fromBlock, toBlock: input.toBlock },
          { split: false },
        ).catch((error: unknown) => {
          input.onUnread?.(error);
          return { logs: [] as RawLog[], truncated: true };
        }),
      ),
    );
    const linked = new Set(links.map((l) => l.address));
    for (const [i, c] of contracts.entries()) {
      const read = reads[i] ?? { logs: [], truncated: true };
      const out = passedOn(read.logs, token, c.address);
      if (out.size < DISTRIBUTOR_MIN_RECIPIENTS) continue;
      distributors.push({
        address: c.address,
        share: share6(c.value, supply),
        recipients: out.size,
        complete: !read.truncated,
      });
      // One hop: a holder that got its tokens from that contract.
      for (const h of listed) {
        const key = h.address.toLowerCase();
        const value = out.get(key);
        if (value === undefined || linked.has(key)) continue;
        linked.add(key);
        links.push({ address: key, share: share6(value, supply), via: c.address });
      }
    }
  }

  const held = new Set(listed.map((h) => h.address.toLowerCase()));
  const recipients = sends.recipients.slice(0, CREATOR_RECIPIENTS_LISTED).map((r) => ({
    address: r.address.toLowerCase(),
    share: share6(BigInt(r.value), supply),
    listed: held.has(r.address.toLowerCase()),
  }));
  const total =
    sends.total !== undefined
      ? BigInt(sends.total)
      : sends.recipients.reduce((n, r) => n + BigInt(r.value), 0n);
  return {
    sentTo: sends.distinct,
    burned: share6(BigInt(sends.burned), supply),
    holders: links,
    distributors,
    recipients,
    sentShare: share6(total, supply),
  };
}

/** Each holder's link, set on the holders list itself. */
export function withLinks(
  data: HolderDistributionData,
  links: CreatorLinks,
): HolderDistributionData {
  const byAddress = new Map(links.holders.map((l) => [l.address, l]));
  return {
    ...data,
    top: data.top.map((h) => {
      const link = byAddress.get(h.address.toLowerCase());
      return link ? { ...h, fromCreator: { share: link.share, via: link.via } } : h;
    }),
    creatorLinks: links,
  };
}
