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
 * | Virtuals       | `0xd4cc…` | 26,184   | 220,679     | open       |
 * |  (tax manager) | `0x6d80…` | 26,185   | 220,679     | open       |
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
  /**
   * How it is said in a sentence, when the label would mislead: "launchpad
   * 0x7ed5… (used by pons)" made the model write "a different launchpad
   * (pons)". Defaults to the name.
   */
  prose?: string;
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

/**
 * Virtuals Protocol on Robinhood Chain, read on chain on 18/10/2026
 * (docs/launchpads.md). The launchpad (its "Bonding" contract, named on
 * Virtuals' own list of contract addresses) emits `PreLaunched(token, pair,
 * virtualId, initialPurchase, (launchMode, airdropBips, needAcf,
 * antiSniperTaxType, isProject60days))`, which does not name the creator.
 * In the same transaction, every time (26,184 launches of 26,184), its tax
 * manager emits `TokenRegistered(token, creator, recipient)` with the creator
 * indexed: the sender of the launch in 25 of 25 sampled.
 */
export const VIRTUALS = {
  /** The launchpad ("Bonding", a proxy): `preLaunch`, `buy`, `sell`, `launch`. */
  bonding: '0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007',
  /** Its configuration: `teamTokenReservedWallet()`, `reserveSupplyParams()` = (500, 5500, 5000). */
  config: '0x3e331fdd9fe54d5047b1b7339fd5c91977d53e2f',
  /** The tax manager: receives the 1 % trading tax, registers each token with its creator. */
  taxManager: '0x6d80b81d9fc56a7a839b1af9006eb49151961ce7',
  /** The curve pairs' factory and router. */
  factory: '0xfc2e4da3edb2e18100473339c763705d263d20a9',
  router: '0xca6395246b4382ba70f886526dd9a9de984f6081',
  agentFactory: '0x43e4c17b15365596caae8e7d00e42bc8e988c2d4',
  /** The VIRTUAL token, the pair token of every launch. */
  virtual: '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31',
  /**
   * `teamTokenReservedWallet()` of the configuration: a wallet (64,277
   * transactions) that receives the 50 % reserved on launches with Automated
   * Capital Formation, and hands it out within minutes: 25 % to the ACF
   * wallet, 25 % to a TokenTable lock made for the token.
   */
  reserveWallet: '0x81f7ca6af86d1ca6335e44a2c28bc88807491415',
  /**
   * The Automated Capital Formation wallet: it received 25 % of every ACF
   * launch sampled (SIRIUS, UMBRA, MIKO, SYNA, POPHIE, HOUSE), and sells it
   * through pools it fills as the price rises, the proceeds going to the team.
   */
  acfWallet: '0xe2890629ef31b32132003c02b29a50a025deee8a',
  /**
   * A batch contract (Multicall3 with admins) the ACF wallet filled SIRIUS's
   * pool through: it received 70.5 M SIRIUS from the ACF wallet on
   * 23/09/2026 and put 50.5 M of it in the V3 pool against USDG in one
   * transaction (0x5a20a246…), 20 M still on it.
   */
  acfBatch: '0x3eb3394f5d89465a77f73a83d3675b0ed051f852',
  /**
   * `graduationExcessBurnWallet()` of the configuration: at graduation, the
   * curve's tokens priced against its virtual liquidity go to it (4.45 % of
   * SIRIUS). A wallet (340 transactions); for SIRIUS it burned nothing and
   * passed them to a Merkle claim contract (0x6da0…) in 14 equal parts.
   */
  excessWallet: '0xaea27856b6284ae071e0685ed594c5b80aea2aa9',
  /** TokenTable's deployer of the per-token locks ("TTUnlocker" clones). */
  tokenTableDeployer: '0x07cd7d504847ccc9a83597faabd0b9a156335ee8',
} as const;

/**
 * Wallets a launchpad sends part of every launch to by its own rule, in the
 * creator's launch transaction: not the creator's doing, and never "delivered
 * by the creator's transaction to an address of its choosing" (SIRIUS: 50 %
 * to Virtuals' reserve wallet, read as one unknown wallet linked to the
 * creator).
 */
export const LAUNCHPAD_WALLETS: ReadonlySet<string> = new Set([VIRTUALS.reserveWallet]);

/** `Swap(uint256,uint256,uint256,uint256)`, emitted by each Virtuals curve pair on a buy or a sale. */
export const VIRTUALS_CURVE_SWAP_TOPIC =
  '0x298c349c742327269dc8de6ad66687767310c948ea309df826f5bd103e19d207';
/** `Graduated(address indexed token, address agentToken)`, emitted by the Virtuals launchpad. */
export const VIRTUALS_GRADUATED_TOPIC =
  '0x381d54fa425631e6266af114239150fae1d5db67bb65b4fa9ecc65013107e07e';

/** The 0x7ed5 launchpad, said so that it is not taken for pons itself. */
const SEVEN_ED5_PROSE = 'the 0x7ed5 launchpad, which the pons site also uses';

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
    prose: SEVEN_ED5_PROSE,
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
    prose: SEVEN_ED5_PROSE,
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
  {
    // Its tax manager first: the record that names the creator.
    id: 'virtuals',
    name: 'Virtuals',
    address: VIRTUALS.taxManager,
    event: 'TokenRegistered(address indexed token, address indexed creator, address)',
    topic0: '0x8c768b5da89e637b23caac626ccd760ef89b9e8eaa2f45bbf8c9d68e231dabef',
    token: { topic: 1 },
    creator: { topic: 2 },
    graduates: true,
    fromBlock: 220_000,
  },
  {
    // The launchpad itself: the curve pair, and the trades on it.
    id: 'virtuals',
    name: 'Virtuals',
    address: VIRTUALS.bonding,
    event:
      'PreLaunched(address indexed token, address indexed pair, uint256 virtualId, uint256 initialPurchase, (uint8 launchMode, uint16 airdropBips, bool needAcf, uint8 antiSniperTaxType, bool isProject60days))',
    topic0: '0xb9ee8aa6d909a3efd0bf1b0bc2bde7f998f7ad30178b0d45f9227f5382cebc8f',
    token: { topic: 1 },
    curve: { topic: 2 },
    curveTrades: [VIRTUALS_CURVE_SWAP_TOPIC],
    graduates: true,
    fromBlock: 220_000,
  },
];

export const launchpadById = (id: string): Launchpad | undefined =>
  LAUNCHPADS.find((l) => l.id === id);

/** A launchpad's name as said in a sentence, from its id or its label. */
export function launchpadProse(idOrName: string): string {
  const pad = LAUNCHPADS.find((l) => l.id === idOrName || l.name === idOrName);
  return pad?.prose ?? pad?.name ?? idOrName;
}

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
  const chosen = own ?? found.find((r) => r.creator) ?? found[0] ?? null;
  return chosen ? merged(chosen, found) : null;
}

/**
 * One launch told by two contracts of the same launchpad: what the chosen
 * record leaves out is taken from the others (Virtuals: the tax manager names
 * the creator, the launchpad names the curve pair).
 */
function merged(chosen: LaunchRecord, found: readonly LaunchRecord[]): LaunchRecord {
  const same = found.filter((r) => r !== chosen && r.launchpad.id === chosen.launchpad.id);
  if (same.length === 0) return chosen;
  const first = <K extends 'curve' | 'pool' | 'market'>(key: K) =>
    chosen[key] ?? same.find((r) => r[key])?.[key] ?? null;
  return { ...chosen, curve: first('curve'), pool: first('pool'), market: first('market') };
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

/**
 * Contracts that hold a launch's tokens for the launch mechanism itself,
 * beyond the launchpads' own addresses: never anyone's position.
 *
 * `0x2674…` is the lock contract of the 0x7ed5 launchpad, read on chain on
 * 18/10/2026: its `factory()` answers 0x7ed5…, its `positionManager()` the v4
 * PositionManager (0x58da…), and it exposes `lockPosition(address,uint256)`,
 * `lockTokenSupply(address,uint256)`, `lockedTokenSupply(address)` and
 * `isLocked(address)`. When a 0x7ed5 curve graduates (HYPURRT, graduation tx
 * 0x4837259f…), the factory sends it 8.163 % of the supply (4/49) and the v4
 * liquidity position NFT in the same transaction, and records both as locked
 * (`isLocked(HYPURRT)` = true, `lockedTokenSupply` = the 8.163 %). It is
 * liquidity infrastructure shared by every graduated 0x7ed5 token (WAFER,
 * WORM, COVENANT, ROBINHOOD, MUT8 show the same 8.163 %), so it is set aside
 * like a pool. Tokens sent to it by hand are not recorded as locked
 * (BOOMER, a 0xf05a token: 6.1 % airdropped to it by its creator, `isLocked`
 * false) but still sit in a launchpad contract, not with a person.
 */
export const LAUNCH_LOCKERS: readonly { address: string; name: string }[] = [
  {
    address: '0x267444d099b10fb5ed7c3cc7b7c767adca574952',
    name: 'the liquidity lock contract of the 0x7ed5 launchpad',
  },
];

/**
 * Trading rules (Uniswap v4 hooks) and the contracts plugged into them that
 * launchpads attach to every market they open. They take fees in the token
 * and hold it for the market's mechanism: never anyone's position. Read on
 * chain on 18/10/2026:
 *
 * - `0xe5e7…` is the hook of the v4 markets 0x7ed5 tokens graduate to
 *   (HYPURRT, MUT8, ROBINHOOD, WAFER, WORM, COVENANT): in every buy it takes
 *   a fee in the token, and it held 2.68 % of HYPURRT, its "largest holder";
 * - `0x4e34…` is Doppler's hook and initializer: named as `hooks` in the
 *   `Initialize` of AML, MEME and KEL, it receives the supply from the
 *   Airlock, seeds the PoolManager with it and owns the positions (AML's
 *   largest holder, KEL's third);
 * - `0x6f02…` is a contract plugged into that hook: it registers each new
 *   Doppler market in its launch transaction (an event keyed by the market
 *   id) and trades a fee on every swap of AML, MEME, AI, BONER, KEL, ASTEROID.
 *
 * Any other market's hook is read from its `Initialize` (deployer.ts) and set
 * aside the same way.
 */
export const LAUNCH_HOOKS: readonly {
  address: string;
  name: string;
  /** What it is when it pays fees out, said where it is not the main pool's hook. */
  payer: string;
}[] = [
  {
    address: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
    name: 'the trading rules (hook) of the markets 0x7ed5 tokens graduate to',
    payer: 'the fee contract of the markets 0x7ed5 tokens graduate to',
  },
  {
    address: '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544',
    name: 'Doppler’s trading rules (hook) and initializer',
    payer:
      'Doppler’s launch contract, which holds the positions of the markets Doppler opens and pays out their fees',
  },
  {
    address: '0x6f02324d20cc679d0e585290caa6b16bacbc0f77',
    name: 'a contract plugged into Doppler’s trading rules (hook)',
    payer: 'a fee contract plugged into Doppler’s launch contract',
  },
];

export type LaunchInfrastructureRole = 'launchpad' | 'locker' | 'hook';

/** Every launchpad, router, lock contract and launch hook SEAL knows, by lowercase address. */
export function launchInfrastructure(): Map<string, LaunchInfrastructureRole> {
  const out = new Map<string, LaunchInfrastructureRole>();
  for (const l of LAUNCHPADS) out.set(l.address.toLowerCase(), 'launchpad');
  for (const l of LAUNCH_LOCKERS) out.set(l.address.toLowerCase(), 'locker');
  for (const l of LAUNCH_HOOKS) out.set(l.address.toLowerCase(), 'hook');
  return out;
}
