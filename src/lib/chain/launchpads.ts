import type { Address } from 'viem';
import type { RawLog } from './logs';

/**
 * Every launch contract seen making tokens on Robinhood Chain, as data.
 *
 * Each one records a launch in an event of its own, and that event is what
 * says, for a token, which launchpad made it, who asked for it, and where its
 * curve or market sits. Read off the chain on 17/10/2026 (docs/launchpads.md):
 * the deploy transactions of fifteen live tokens, the event decoded field by
 * field, then each event counted over the contract's whole history.
 *
 * | launchpad      | contract  | launches | first block | last block |
 * | -------------- | --------- | -------- | ----------- | ---------- |
 * | pons           | 5 factories | ~330,000 | 61,869   | open       |
 * | flap.sh        | `0x2660…` | 373,159  | 4,227,932   | open       |
 * | curve `0x7ed5…`| `0x7ed5…` | 699,362  | 27,027,321  | open       |
 * |  (its router)  | `0xe33e…` | 459,887  | 27,027,321  | open       |
 * | curve `0x3d6e…`| `0x3d6e…` | 1,936    | 88,527,856  | open       |
 * | v4 `0xf05a…`   | `0xf05a…` | 211      | 87,735,869  | open       |
 * | Doppler front  | `0x22e9…` | 31,742   | 8,658,626   | 59,235,550 |
 * | Doppler Airlock| `0xeb7c…` | 211,113  | 734,616     | open       |
 * | metricpad      | `0xd8e6…` | 1        | 89,559,296  | open       |
 *
 * A launchpad that is not listed here is still traced, through the token's
 * first mint (deployer.ts): only its name and its other launches are missing.
 */

/** Where a field of the launch event sits: an indexed topic, or a 32-byte word of the data. */
export type EventField = { topic: 1 | 2 | 3 } | { word: number };

export type Launchpad = {
  /** Stable id, also stored by the indexer next to each launch. */
  id: string;
  /** How the launchpad is called on the report. */
  name: string;
  /** The contract that emits the launch event. */
  address: Address;
  /** The event, as verified by decoding a real log. */
  event: string;
  topic0: string;
  token: EventField;
  /**
   * Who asked for the launch. Absent when the event does not say (Doppler's
   * Airlock): the creator is then the sender of the transaction.
   */
  creator?: EventField;
  /**
   * Where the bonding curve holds the tokens before they reach a market: the
   * contract itself, or a field of the event. A transfer into it is a trade
   * on the curve only when the curve emitted one of `curveTrades`.
   */
  curve?: 'emitter' | EventField;
  curveTrades?: readonly string[];
  /** A V2/V3 pool created at launch and named in the event. */
  pool?: EventField;
  /** A Uniswap v4 market id created at launch and named in the event. */
  market?: EventField;
  /** pons only: the factory answers `getLaunchedToken`, and graduation is read. */
  getter?: boolean;
  /**
   * Whether a launch moves on from its curve to an open market. SEAL reads
   * that step on pons only: elsewhere it exists but is not measured, and on a
   * launchpad that opens the market at once it does not apply.
   */
  graduates: boolean;
  fromBlock: number;
  /** A launchpad that stopped launching: nothing to read after this block. */
  toBlock?: number;
};

const PONS_EVENT =
  'TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)';
const PONS_TOPIC = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';

function pons(address: Address, fromBlock: number, toBlock?: number, getter = true): Launchpad {
  return {
    id: 'pons',
    name: 'pons',
    address,
    event: PONS_EVENT,
    topic0: PONS_TOPIC,
    token: { topic: 1 },
    creator: { topic: 2 },
    pool: { word: 1 },
    getter,
    graduates: true,
    fromBlock,
    ...(toBlock !== undefined ? { toBlock } : {}),
  };
}

/** flap.sh `TokenSold(uint256 ts, address token, address seller, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice)`. */
export const FLAP_TOKEN_SOLD_TOPIC =
  '0x03a4693e592f5e75dc7c136acb39b146d2b4966c0e509c34f362dee02b3b861a';
/** flap.sh `TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)`. */
export const FLAP_TOKEN_BOUGHT_TOPIC =
  '0xa800a2038683844fac66747f771bfdfae862eb28b16bcfa387afa9fbacce8ff7';
/** `CurveBuy(address,address,uint256,uint256,uint256,uint256)` and `CurveSell(…)`, emitted by each 0x7ed5 curve. */
export const CURVE_BUY_TOPIC = '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455';
export const CURVE_SELL_TOPIC =
  '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df';
/** `Trade(address,address,address,address,uint8,bool,uint256,…)`, emitted by each 0x3d6e curve on a buy or a sale. */
export const CURVE_TRADE_TOPIC =
  '0xaca20dddb264298fd1f9f05d1dc1e0847e30f73956ee42aaf896b91eb73628b6';

export const LAUNCHPADS: readonly Launchpad[] = [
  // pons: five factory generations, all with the same `TokenLaunched`.
  pons('0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75', 39_000_000),
  // Same event, but `getLaunchedToken` returns another layout and
  // `graduationStatus` does not answer: probably a fork of the launchpad.
  pons('0xa24d48d50fd7985c6de816eaf77c1a17d3593bbe', 12_000_000, undefined, false),
  pons('0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb', 8_991_118, 40_000_000),
  pons('0x0c37a24f5d23a486fa692d1500881d698b1f77a4', 8_600_612, 35_000_000),
  // The first generation, before the public launch: 60,142 launches between
  // blocks 61,869 and 6,880,646, with the same companion events
  // (`TokenDeployed`, `PositionLocked`) as 0x0c37, and `getLaunchedToken`
  // answering with the documented layout.
  pons('0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb', 61_869, 7_000_000),
  {
    id: 'flap',
    name: 'flap.sh',
    // The portal (`version()` = v5.23.1): it holds every curve.
    address: '0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09',
    event:
      'TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta)',
    topic0: '0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603',
    token: { word: 3 },
    // Nothing is indexed: the creator's other launches cannot be filtered
    // from the node, only from the indexer.
    creator: { word: 1 },
    curve: 'emitter',
    curveTrades: [FLAP_TOKEN_SOLD_TOPIC, FLAP_TOKEN_BOUGHT_TOPIC],
    graduates: true,
    fromBlock: 4_200_000,
  },
  {
    id: 'curve-7ed5',
    name: 'launchpad 0x7ed5… (used by pons)',
    address: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
    event:
      'TokenLaunched(address indexed token, address indexed curve, address indexed creator, address, uint256, uint256)',
    topic0: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
    token: { topic: 1 },
    creator: { topic: 3 },
    curve: { topic: 2 },
    curveTrades: [CURVE_BUY_TOPIC, CURVE_SELL_TOPIC],
    graduates: true,
    fromBlock: 27_000_000,
  },
  {
    // The router in front of 0x7ed5: 459,887 of its launches go through it,
    // and it names the wallet that called it where the factory may name a
    // contract in between (0xeec4…: the factory names 0x274a…, a contract).
    id: 'curve-7ed5',
    name: 'launchpad 0x7ed5… (used by pons)',
    address: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
    event:
      'Launched(address indexed token, address indexed curve, address indexed creator, address, uint256, uint256)',
    topic0: '0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37',
    token: { topic: 1 },
    creator: { topic: 3 },
    curve: { topic: 2 },
    curveTrades: [CURVE_BUY_TOPIC, CURVE_SELL_TOPIC],
    graduates: true,
    fromBlock: 27_000_000,
  },
  {
    id: 'curve-3d6e',
    name: 'launchpad 0x3d6e…',
    address: '0x3d6ea4e97b8ab9e1a1b4943febffe22d8c920091',
    event:
      'Launched(address indexed token, address indexed curve, address indexed creator, (address token, address curve, address quote, address creator, …, bytes32 poolId, …) params)',
    topic0: '0xa0354dae199953f2dbde6be8415166a744e7f92b7328671692196d8fdbb6bd9d',
    token: { topic: 1 },
    creator: { topic: 3 },
    curve: { topic: 2 },
    curveTrades: [CURVE_TRADE_TOPIC],
    // The v4 market it graduates into, already named at launch.
    market: { word: 11 },
    graduates: true,
    fromBlock: 88_500_000,
  },
  {
    id: 'v4-f05a',
    name: 'launchpad 0xf05a…',
    address: '0xf05a26e92e27b8f0385f6895f5507db26a2f4b8d',
    event:
      'TokenLaunched(address indexed token, address indexed creator, address indexed quote, bool)',
    topic0: '0x8f9d1d4b2dfe54f1d49ec1d5b6a7b5bc380b5fac115339c49e671127d1481c69',
    token: { topic: 1 },
    creator: { topic: 2 },
    graduates: false,
    fromBlock: 87_700_000,
  },
  {
    id: 'doppler-22e9',
    name: 'Doppler launchpad 0x22e9…',
    address: '0x22e99278308b393ea1260859b181ad7e78f5eeed',
    event:
      'LaunchCreated(address indexed token, address indexed, address indexed numeraire, address initializer, address creator, bytes32, uint48, uint48, string)',
    topic0: '0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b',
    token: { topic: 1 },
    creator: { word: 1 },
    graduates: true,
    fromBlock: 8_600_000,
    toBlock: 60_000_000,
  },
  {
    id: 'doppler',
    name: 'Doppler',
    // The Airlock: `Create(address asset, address indexed numeraire, address
    // initializer, address poolOrHook)`. It does not name the creator.
    address: '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862',
    event:
      'Create(address asset, address indexed numeraire, address initializer, address poolOrHook)',
    topic0: '0x68ff1cfcdcf76864161555fc0de1878d8f83ec6949bf351df74d8a4a1a2679ab',
    token: { word: 0 },
    graduates: true,
    fromBlock: 700_000,
  },
  {
    id: 'metricpad',
    name: 'metricpad',
    address: '0xd8e6fda8639b53c63ffe78eee5431d1af3c56c88',
    event:
      'Launched(address indexed creator, address indexed token, address indexed pool, address, string, string, string)',
    topic0: '0x14ab72c95fd9b13db14c65da0cd02173bfd0aea9005b9ed422810bb985b5942e',
    token: { topic: 2 },
    creator: { topic: 1 },
    pool: { topic: 3 },
    graduates: false,
    fromBlock: 89_500_000,
  },
];

export const launchpadById = (id: string): Launchpad | undefined =>
  LAUNCHPADS.find((l) => l.id === id);

const lower = (value: string) => value.toLowerCase();

/** A field read as an address: the last 20 bytes of its 32. */
function readAddress(log: RawLog, field: EventField): string | null {
  const raw = readWord(log, field);
  if (!raw) return null;
  const address = `0x${raw.slice(24)}`;
  return /^0x0{40}$/.test(address) ? null : address;
}

function readWord(log: RawLog, field: EventField): string | null {
  if ('topic' in field) {
    const topic = log.topics[field.topic];
    return topic && /^0x[0-9a-f]{64}$/i.test(topic) ? lower(topic.slice(2)) : null;
  }
  const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  const word = data.slice(field.word * 64, field.word * 64 + 64);
  return word.length === 64 ? lower(word) : null;
}

/** The launch as one launchpad's event records it. */
export type LaunchRecord = {
  launchpad: Launchpad;
  token: string;
  /** `null` when the event does not name one. */
  creator: string | null;
  curve: string | null;
  pool: string | null;
  market: string | null;
  blockNumber: number;
  transactionHash: string;
};

export function isLaunchEvent(launchpad: Launchpad, log: RawLog): boolean {
  return (
    lower(log.address) === launchpad.address && lower(log.topics[0] ?? '') === launchpad.topic0
  );
}

/** Reads a launch event of `launchpad`; `null` when the log is not one or is malformed. */
export function readLaunchRecord(launchpad: Launchpad, log: RawLog): LaunchRecord | null {
  if (!isLaunchEvent(launchpad, log)) return null;
  const token = readAddress(log, launchpad.token);
  if (!token) return null;
  const curve =
    launchpad.curve === 'emitter'
      ? launchpad.address
      : launchpad.curve
        ? readAddress(log, launchpad.curve)
        : null;
  const market = launchpad.market ? readWord(log, launchpad.market) : null;
  return {
    launchpad,
    token,
    creator: launchpad.creator ? readAddress(log, launchpad.creator) : null,
    curve,
    pool: launchpad.pool ? readAddress(log, launchpad.pool) : null,
    market: market && !/^0{64}$/.test(market) ? `0x${market}` : null,
    blockNumber: Number(log.blockNumber),
    transactionHash: log.transactionHash,
  };
}

/**
 * The launch record of `token` among a transaction's logs. A launchpad that
 * names the creator wins over one that does not (a front-end over Doppler's
 * Airlock emits both).
 */
export function findLaunchRecord(
  token: string,
  logs: readonly RawLog[],
  /** Who sent the transaction: a record naming them wins (a router's record over its factory's). */
  sender?: string,
): LaunchRecord | null {
  const found: LaunchRecord[] = [];
  for (const log of logs) {
    for (const launchpad of LAUNCHPADS) {
      const record = readLaunchRecord(launchpad, log);
      if (record && record.token === lower(token)) found.push(record);
    }
  }
  const own = sender ? found.find((r) => r.creator === lower(sender)) : undefined;
  return own ?? found.find((r) => r.creator) ?? found[0] ?? null;
}

/**
 * The topic filter listing one creator's launches, when the event indexes the
 * creator; `null` when it does not (flap.sh, Doppler): the node cannot filter
 * on a data field.
 */
export function creatorFilter(launchpad: Launchpad, creator: string): (string | null)[] | null {
  const field = launchpad.creator;
  if (!field || !('topic' in field)) return null;
  const topic = `0x${lower(creator).replace(/^0x/, '').padStart(64, '0')}`;
  return Array.from({ length: field.topic + 1 }, (_, i) =>
    i === 0 ? launchpad.topic0 : i === field.topic ? topic : null,
  );
}
