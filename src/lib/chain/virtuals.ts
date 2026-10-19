import type { LaunchGraduation } from '../contracts/creator';
import { IncompleteDataError } from '../errors';
import { TRANSFER_TOPIC } from './behavior';
import { VIRTUALS, VIRTUALS_GRADUATED_TOPIC } from './launchpads';
import { getLogsBatched, type RawLog } from './logs';
import type { RpcClient } from './rpc';

/**
 * Graduation on Virtuals, read from the launchpad's own event.
 *
 * `Graduated(address indexed token, address agentToken)` is emitted by the
 * launchpad (0xd4cc…) when a curve is full: SIRIUS graduated on 23/09/2026
 * (block 70,428,026, tx 0x1b082665…). In that transaction the curve pair
 * hands what it holds to the launchpad, which seeds the Uniswap v2 pair
 * (10.47 % of SIRIUS, through the token contract) and sends the "excess" —
 * tokens priced against the curve's virtual liquidity — to the wallet the
 * configuration calls `graduationExcessBurnWallet()` (4.45 %). For SIRIUS
 * that wallet did not burn them: it passed them on to a Merkle claim
 * contract in 14 equal parts.
 */

const lower = (a: string) => a.toLowerCase();
const topicOf = (address: string) => `0x${lower(address).replace(/^0x/, '').padStart(64, '0')}`;

/** Every Virtuals launch among `tokens` that graduated, with its `Graduated` log. */
export async function readVirtualsGraduations(
  rpc: RpcClient,
  tokens: readonly { token: string; blockNumber: number }[],
  latest: number,
): Promise<Map<string, RawLog>> {
  if (tokens.length === 0) return new Map();
  const fromBlock = Math.min(...tokens.map((t) => t.blockNumber));
  const { logs, truncated } = await getLogsBatched(
    rpc,
    {
      addresses: [VIRTUALS.bonding],
      topics: [VIRTUALS_GRADUATED_TOPIC, tokens.map((t) => topicOf(t.token))],
    },
    { fromBlock, toBlock: latest },
  );
  // A window not read could hold a graduation: never "not graduated".
  if (truncated) {
    throw new IncompleteDataError(
      'robinhood-rpc',
      'some windows of the Virtuals launchpad could not be read, so graduation is unknown',
    );
  }
  const out = new Map<string, RawLog>();
  for (const log of logs) {
    const token = `0x${(log.topics[1] ?? '').slice(26)}`.toLowerCase();
    if (!out.has(token)) out.set(token, log);
  }
  return out;
}

const share6 = (value: bigint, supply: bigint) =>
  supply > 0n ? Number((value * 1_000_000n) / supply) / 1_000_000 : 0;

/**
 * Where the curve's tokens went at graduation: to the market, and to the
 * excess wallet. Transfers that only pass through the launchpad or the token
 * contract are followed to where they land.
 */
export function graduationMoves(
  token: string,
  receiptLogs: readonly RawLog[],
  supply: bigint,
  markets: readonly string[],
): Pick<LaunchGraduation, 'market' | 'excess'> {
  const relays = new Set<string>([VIRTUALS.bonding, lower(token)]);
  const pools = new Set(markets.map(lower));
  let marketAddress: string | null = null;
  let marketValue = 0n;
  let excess = 0n;
  for (const log of receiptLogs) {
    if (lower(log.address) !== lower(token) || log.topics[0] !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 3) continue;
    const from = `0x${(log.topics[1] ?? '').slice(26)}`;
    const to = `0x${(log.topics[2] ?? '').slice(26)}`;
    if (!relays.has(from)) continue;
    const raw = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
    const value = BigInt(`0x${raw.slice(0, 64) || '0'}`);
    if (pools.has(to)) {
      marketAddress = to;
      marketValue += value;
    } else if (to === VIRTUALS.excessWallet) {
      excess += value;
    }
  }
  return {
    market: marketAddress ? { address: marketAddress, share: share6(marketValue, supply) } : null,
    excess: excess > 0n ? { address: VIRTUALS.excessWallet, share: share6(excess, supply) } : null,
  };
}

/** The token's graduation in full: when, and where the curve's tokens went. */
export async function readVirtualsGraduation(
  rpc: RpcClient,
  token: string,
  log: RawLog,
  supply: bigint,
  markets: readonly string[],
): Promise<LaunchGraduation> {
  const [receipt, block, balance] = await rpc.callBatch<unknown>([
    { method: 'eth_getTransactionReceipt', params: [log.transactionHash] },
    { method: 'eth_getBlockByNumber', params: [log.blockNumber, false] },
    // What the excess wallet holds today: it passes its tokens on (SIRIUS: to
    // a Merkle claim contract), so what it received says nothing of now.
    {
      method: 'eth_call',
      params: [
        { to: token, data: `0x70a08231${VIRTUALS.excessWallet.slice(2).padStart(64, '0')}` },
        'latest',
      ],
    },
  ]);
  const logs = receipt?.ok ? (receipt.value as { logs?: RawLog[] } | null)?.logs : undefined;
  if (!Array.isArray(logs)) {
    throw new IncompleteDataError('robinhood-rpc', 'the graduation transaction could not be read');
  }
  const stamp = block?.ok ? (block.value as { timestamp?: string } | null)?.timestamp : undefined;
  const timestamp = stamp !== undefined ? Number(stamp) : NaN;
  const moves = graduationMoves(token, logs, supply, markets);
  const held = balance?.ok && typeof balance.value === 'string' ? balance.value : null;
  if (moves.excess && held && /^0x[0-9a-f]*$/i.test(held) && supply > 0n) {
    moves.excess.heldNow = share6(BigInt(held === '0x' ? '0x0' : held), supply);
  }
  return {
    block: Number(log.blockNumber),
    transaction: log.transactionHash,
    at: Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : null,
    ...moves,
  };
}
