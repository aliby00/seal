import { launchpadProse } from '../chain/launchpads';
import { NATIVE } from '../chain/pools';
import { OTHER_LAUNCH_SALES_DAYS } from '../contracts/creator';
import { checkedByLaunchpad, checkedWords, joinClauses } from '../checked-sample';
import { poolLabel, usdShort, volumePerTrade } from '../market';
import { decodeHookPermissions, describeHookPermissions } from '../chain/hooks';
import { feePayerWords, whereSetAside } from '../set-aside';
import { lockWords } from '../supply-flow';
import {
  addressesSoftware,
  describeService,
  imitatedName,
  normalizeName,
  quoteName,
} from './names';
import { SERVICE_TX_COUNT, type FunderKind } from '../chain/funder-kind';
import { mostHoldersFromCreator } from '../contracts/holders';
import { readFailed } from '../failed-reads';
import type {
  Finding,
  FundingDisplay,
  PoolRules,
  FundingPathStep,
  Signal,
  Specialist,
  SpecialistContext,
  SpecialistId,
} from './types';

/**
 * Les dix spécialistes.
 *
 * Tous déterministes : à entrée égale, sortie égale, sans appel de modèle.
 * Les seuils sont des constantes nommées, pas des réglages cachés — quelqu'un
 * qui conteste un constat doit pouvoir lire pourquoi il a été fait.
 */

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
/** A share near the ends: "<0.1%" and ">99.9%" rather than "0.0%" and "100.0%". */
const pctBounded = (x: number): string =>
  x > 0 && x < 0.001 ? '<0.1%' : x > 0.999 && x < 1 ? '>99.9%' : pct(x);

function finding(
  specialist: SpecialistId,
  signal: Signal,
  facts: string[],
  limits: string[] = [],
  followUps?: SpecialistId[],
): Finding {
  return { specialist, signal, facts, limits, ...(followUps?.length ? { followUps } : {}) };
}

const unknown = (id: SpecialistId, why: string): Finding => finding(id, 'unknown', [], [why]);

/** A question that does not apply to this token: said so, never "not measured". */
const notApplicable = (id: SpecialistId, why: string): Finding => ({
  ...finding(id, 'unknown', [], [why]),
  notApplicable: true,
});

/**
 * The token's main market when it is a V2/V3 pair: a 20-byte pair address
 * (a v4 pool is a 32-byte id), with its version when the listing gives it.
 */
export function pairMarket(
  report: SpecialistContext['report'],
): { label: string; version: 'v2' | 'v3' | null } | null {
  const data = report?.market.data;
  if (!data?.pair || !/^0x[0-9a-fA-F]{40}$/.test(data.pair)) return null;
  if (data.graduation && !data.graduation.graduated) return null;
  const listed = data.pools?.find((p) => p.id.toLowerCase() === data.pair!.toLowerCase());
  const version = listed?.version === 'v2' || listed?.version === 'v3' ? listed.version : null;
  return { label: poolLabel(data.pair), version };
}

/** "not applicable: this market has no trading-rules contract (Uniswap v2 pair 0x8285…dbA5)". */
export function noRulesContract(pair: NonNullable<ReturnType<typeof pairMarket>>): string {
  return `not applicable: this market has no trading-rules contract (Uniswap ${pair.version ?? 'v2/v3'} pair ${pair.label})`;
}

/** A v4-only question on a token whose market is a V2/V3 pair does not apply; elsewhere it is unknown. */
function v4Only(id: SpecialistId, report: SpecialistContext['report']): Finding {
  const pair = pairMarket(report);
  return pair ? notApplicable(id, noRulesContract(pair)) : unknown(id, noV4Market(report));
}

/**
 * Where the token trades when it has no Uniswap v4 market, said for a person:
 * the questions that read a v4 rulebook then say why there is nothing to read,
 * rather than a bare "not found".
 */
export function marketElsewhere(report: SpecialistContext['report']): string | null {
  const data = report?.market.data;
  if (!data) return null;
  if (data.graduation && !data.graduation.graduated) return 'its launch pool';
  if (data.pair)
    return `a trading pair listed by DexScreener (${data.pair.slice(0, 6)}…${data.pair.slice(-4)})`;
  return null;
}

/** Why a v4-only question has no answer, in plain words. */
export function noV4Market(report: SpecialistContext['report']): string {
  const where = marketElsewhere(report);
  return where
    ? `this token trades on ${where}, not on a Uniswap v4 pool, so there are no Uniswap v4 trading rules (hook) for this question to read`
    : 'no market was found for this token: no Uniswap v4 pool, no launch pool, and no pair listed by DexScreener';
}

/**
 * Why the name question has no answer. Its comparison runs over the v4 market
 * index, but it is about names, not trading rules: borrowing the v4 wording
 * told the reader there was no hook to read, which was beside the point.
 */
export function namesNotCompared(report: SpecialistContext['report']): string {
  const pair = pairMarket(report);
  if (pair) {
    return `the name was not checked: names are compared only across Uniswap v4 markets, and this token trades on a Uniswap ${pair.version ?? 'v2/v3'} pair (${pair.label})`;
  }
  const where = marketElsewhere(report);
  return where
    ? `the name was not checked: names are compared only across Uniswap v4 markets, and this token trades on ${where}`
    : 'the name was not checked: no market was found for this token to compare it with earlier ones';
}

/**
 * Familles de tokens reconnues par leur beacon EIP-1967.
 *
 * Relevé le 11/10/2026 : les tokens « … • Robinhood Token » (AMZN, SPCX…)
 * sont des beacon proxies vers la même adresse ; le token « HOOD » observé le
 * même jour n'est pas un beacon proxy du tout. Ce n'est
 * pas une preuve d'émetteur — n'importe qui peut pointer un proxy vers un
 * beacon existant — d'où un constat `observation`, jamais `reassurance`.
 */
export const RECOGNISED_BEACONS: Record<string, string> = {
  '0xe10b6f6b275de231345c20d14ab812db62151b00': 'the tokenised stocks named "… • Robinhood Token"',
};

/** À partir de combien de marchés un rulebook partagé devient un fait notable. */
export const REUSE_NOTABLE = 5;
/** Part des marchés frères ayant mal fini au-delà de laquelle la réutilisation devient un motif d'attention. */
export const SIBLING_HARM_SHARE = 0.5;
/** Un créateur sous ce nombre de transactions n'a pratiquement pas d'existence avant ce lancement. */
export const FRESH_WALLET_NONCE = 3;
export const TOP1_CONCERN = 0.2;
export const TOP10_CONCERN = 0.5;
export const TOP10_SPREAD = 0.25;
export const SPREAD_MIN_HOLDERS = 50;
/** En dessous de 10 % d'adresses distinctes par échange, le volume vient de peu de mains. */
export const TRADERS_PER_TRADE_CONCERN = 0.1;
export const MIN_TRADES_FOR_VOLUME = 20;

/** Why the market questions stop: the main pool's rules were not read. */
const MAIN_UNREAD =
  'the trading rules (hook) of this token’s main pool could not be read this time';

const hooked = (p: PoolRules) => typeof p.hook === 'string' && p.hook !== NATIVE;

/** "0xf4a6…0935, $186.4k liquidity": a pool named with its size. */
function poolDetail(pool: PoolRules): string {
  return `${poolLabel(pool.id)}${pool.liquidityUsd !== null ? `, ${usdShort(pool.liquidityUsd)} liquidity` : ''}`;
}

/** "The main pool of this token (0xf4a6…0935, $186.4k liquidity)", or "This market" without a listing. */
function mainSubject(context: SpecialistContext): string {
  return context.mainPool
    ? `The main pool of this token (${poolDetail(context.mainPool)})`
    : 'This market';
}

const MAX_POOL_LINES = 3;

/**
 * The other pools whose rules differ from the main pool's, one line each:
 * a hook where the main pool has none or another one, no hook where it has
 * one, rules that could not be read. Empty when they all match.
 */
function otherPoolLines(context: SpecialistContext, mainHook: string | null): string[] {
  const differ = (context.otherPools ?? []).filter((p) =>
    p.hook === undefined ? true : hooked(p) ? p.hook !== mainHook : mainHook !== null,
  );
  // Pools with a hook first: they are the ones a sell can pass through.
  differ.sort((a, b) => Number(hooked(b)) - Number(hooked(a)));
  const lines = differ.slice(0, MAX_POOL_LINES).map((p) => {
    const where = `Another pool of this token (${poolDetail(p)})`;
    if (p.hook === undefined)
      return `${where} is a Uniswap v4 pool whose trading rules (hook) could not be read this time.`;
    if (hooked(p)) {
      const alters = describeHookPermissions(decodeHookPermissions(p.hook as string)).some(
        (c) => c.id === 'alters-swap-amounts',
      );
      return `${where} runs trading rules (hook) ${p.hook}${alters ? ', which may change the amount of a trade' : ''}: a trade in that pool passes through them.`;
    }
    return p.version === 'v4'
      ? `${where} runs no trading rules (hook).`
      : `${where} is a Uniswap ${p.version ?? 'v2/v3'} pair, with no hook.`;
  });
  if (differ.length > MAX_POOL_LINES) {
    lines.push(
      `${differ.length - MAX_POOL_LINES} more pool(s) of this token differ in the same way.`,
    );
  }
  return lines;
}

/**
 * Pools beside the main one that run a hook, or whose rules could not be
 * read: either way, "no contract sits between a sell and the pool" is not
 * true of every pool the token trades in.
 */
const otherHooks = (context: SpecialistContext): PoolRules[] =>
  (context.otherPools ?? []).filter((p) => hooked(p) || p.hook === undefined);

/** The limit given when the indexer's chain-wide count of a hook's markets could not be read. */
export const HOOK_COUNT_UNREAD =
  'the chain-wide count of markets on these trading rules could not be read from the SEAL indexer this time, so this is a partial read of a recent window';

const codeReuse: Specialist = {
  id: 'code-reuse',
  title: 'Code Reuse',
  question: 'Have this market’s trading rules (hook) already been used by other markets?',
  run(context: SpecialistContext): Finding {
    const { market, index, report, hookUse } = context;
    if (context.mainRulesUnread) return unknown('code-reuse', MAIN_UNREAD);
    if (!market) {
      if (otherHooks(context).length > 0 && context.mainPool) {
        return finding(
          'code-reuse',
          'observation',
          [
            `The main pool of this token (${poolLabel(context.mainPool.id)}) is a Uniswap ${context.mainPool.version ?? 'v2/v3'} pair, with no trading rules (hook).`,
            ...otherPoolLines(context, null),
          ],
          [],
          ['sell-path', 'rule-change'],
        );
      }
      return v4Only('code-reuse', report);
    }
    if (market.hook === NATIVE) {
      const others = otherPoolLines(context, null);
      if (otherHooks(context).length > 0) {
        return finding(
          'code-reuse',
          'observation',
          [`${mainSubject(context)} runs without trading rules (hook).`, ...others],
          [],
          ['sell-path', 'rule-change'],
        );
      }
      return finding('code-reuse', 'quiet', ['This market runs without trading rules (no hook).']);
    }
    const others = otherPoolLines(context, market.hook);
    // The whole history, from the indexer: a recent window counted "1
    // market" for each of four tokens on the same hook (0xe5e7…).
    if (hookUse) {
      const covered = market.blockNumber <= hookUse.indexedTo;
      const total = hookUse.markets + (covered ? 0 : 1);
      const facts = [
        `The trading rules (hook) ${market.hook} are used by ${total} market(s) on Robinhood Chain, this one included (every Uniswap v4 market the SEAL indexer has read, up to block ${hookUse.indexedTo}).`,
        ...others,
      ];
      if (total < REUSE_NOTABLE) return finding('code-reuse', 'quiet', facts);
      return finding(
        'code-reuse',
        'observation',
        facts,
        [
          'Shared trading rules can be a launchpad’s standard ones; reuse alone does not say what they do.',
        ],
        ['rule-change', 'sell-path'],
      );
    }
    if (!index || index.size === 0) {
      return unknown('code-reuse', 'the cross-market index was not loaded');
    }
    const siblings = index.onHook(market.hook).filter((m) => m.id !== market.id);
    const range = index.all();
    const from = range[0]?.blockNumber;
    const window = `the markets created in about the last 50 minutes (blocks ${from} to ${range.at(-1)?.blockNumber})`;
    const inWindow = from !== undefined && market.blockNumber >= from;
    const windowLimit = `only ${window} were compared${inWindow ? '' : ', and this market was created before them'}: earlier markets on the same trading rules are not counted`;
    // The indexer was asked and did not answer: this window is all there is,
    // and the report says the count is partial (AML: "14 other markets", for
    // a hook 210,175 markets run on).
    const limitsFirst = hookUse === null ? [HOOK_COUNT_UNREAD] : [];
    const counted = (n: number) =>
      `Among ${window} only, ${n} other market${n === 1 ? '' : 's'} use${n === 1 ? 's' : ''} the trading rules (hook) ${market.hook}: a count of that recent window, not of the whole chain.`;
    if (siblings.length + 1 < REUSE_NOTABLE) {
      return finding(
        'code-reuse',
        'quiet',
        [counted(siblings.length), ...others],
        [...limitsFirst, windowLimit],
      );
    }
    const facts = [counted(siblings.length)];
    const tokens = new Set(siblings.map((s) => s.token));
    facts.push(`Those markets list ${tokens.size} distinct other token(s).`);
    facts.push(...others);
    const judged = siblings.filter((s) => s.outcome === 'harmed' || s.outcome === 'unharmed');
    const harmed = judged.filter((s) => s.outcome === 'harmed').length;
    const limits = [
      ...limitsFirst,
      'Shared trading rules can be a launchpad’s standard ones; reuse alone does not say what they do.',
      windowLimit,
    ];
    if (judged.length === 0) {
      limits.push('What happened afterwards to the other markets is not known yet.');
      return finding('code-reuse', 'observation', facts, limits, ['rule-change', 'sell-path']);
    }
    facts.push(
      `Of the ${judged.length} sibling market(s) whose outcome is known, ${harmed} later saw liquidity removed or the creator sell.`,
    );
    const share = harmed / judged.length;
    return finding(
      'code-reuse',
      share >= SIBLING_HARM_SHARE ? 'concern' : harmed === 0 ? 'reassurance' : 'observation',
      facts,
      limits,
      ['rule-change', 'sell-path'],
    );
  },
};

const walletAge: Specialist = {
  id: 'wallet-age',
  title: 'Wallet Age',
  question: 'Did the creator’s wallet exist before this launch?',
  run({ creatorNonce, report }: SpecialistContext): Finding {
    if (creatorNonce === null || creatorNonce === undefined) {
      return unknown('wallet-age', 'the creator wallet was not identified or not readable');
    }
    // Un historique indisponible n'est pas un historique vide : on ne dit rien
    // plutôt que « 0 lancement ».
    const creator = report?.creator;
    const launched =
      creator && creator.completeness !== 'unavailable' ? creator.data.counts.launched : undefined;
    const facts = [`The creator wallet has sent ${creatorNonce} transaction(s) in total.`];
    // A count from a listing that failed is a minimum, said as one.
    const unread = readFailed(report?.failedReads, 'creator-launches');
    if (launched !== undefined)
      facts.push(
        unread
          ? `It launched at least ${launched} token(s); some of its launches could not be read this time.`
          : `It launched ${launched} token(s) in the scanned range.`,
      );
    if (creatorNonce <= FRESH_WALLET_NONCE) {
      facts.push('This launch is among the very first actions of that wallet.');
      return finding('wallet-age', 'concern', facts, [], ['funding-trace']);
    }
    return finding('wallet-age', 'quiet', facts);
  },
};

const plural = (n: number, word: string) =>
  `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
/** "1 address", "10100 addresses": the count as the data gives it. */
const addresses = (n: number) => `${n} ${n === 1 ? 'address' : 'addresses'}`;

/** A Blockscout contract name is chosen by its deployer: quoted as data, like a token name. */
const contractName = (name: string | null | undefined): string =>
  name ? quoteName(name) : 'unnamed';

function fundingFinding(
  signal: Signal,
  facts: string[],
  limits: string[],
  display: FundingDisplay,
  followUps?: SpecialistId[],
): Finding {
  return { ...finding('funding-trace', signal, facts, limits, followUps), funding: display };
}

const fundingTrace: Specialist = {
  id: 'funding-trace',
  title: 'Funding Trace',
  question: 'Who paid for the creator’s wallet, and did they fund other creators?',
  run({ funding }: SpecialistContext): Finding {
    if (funding === undefined) {
      return unknown(
        'funding-trace',
        'Who first sent money to the creator’s wallet was not looked up for this token.',
      );
    }
    if (funding === null) {
      return finding('funding-trace', 'quiet', [
        'No incoming funding transfer was found for the creator.',
      ]);
    }
    const facts: string[] = [];
    const limits: string[] = [];
    // Who the funding really came from: the funder, or the sender behind a tool.
    let who = funding.funder;
    let kind: FunderKind = funding.funderKind;
    let txCount = funding.funderTxCount ?? null;
    let name = funding.funderName ?? null;
    const viaTool = kind === 'tool';
    if (viaTool) {
      const tool = contractName(funding.funderName);
      if (!funding.origin) {
        facts.push(
          `The creator wallet was first funded through a batch-sending tool (${tool}, ${funding.funder}).`,
        );
        limits.push(
          'who sent the funding through that tool was not read, so the funder behind it is not known',
        );
        return fundingFinding('unknown', facts, limits, {
          kind: 'unknown',
          linkedCreators: 0,
          launches: null,
          depth: 0,
          path: [
            { address: funding.funder, kind: 'tool', name: funding.funderName ?? null, txCount },
          ],
        });
      }
      facts.push(
        `The creator wallet was first funded with a transfer sent through a batch-sending tool (${tool}) by ${funding.origin}.`,
      );
      who = funding.origin;
      kind = funding.originKind === 'tool' ? 'unknown' : (funding.originKind ?? 'unknown');
      txCount = funding.originTxCount ?? null;
      name = null;
    }
    const ownPath: FundingPathStep[] = [
      {
        address: who,
        kind,
        name,
        txCount,
        ...(viaTool ? { via: { address: funding.funder, name: funding.funderName ?? null } } : {}),
      },
    ];
    const network = funding.network;
    const path = network && network.path.length > 0 ? network.path : ownPath;
    const display = (linked: number, launches: number | null, depth: number): FundingDisplay => ({
      kind,
      linkedCreators: linked,
      launches,
      depth,
      path,
    });

    if (kind === 'service') {
      // "High-volume" only when the count says so: a contract with 0
      // transactions sent is a contract, and a contract links nobody.
      const what = describeService(name, txCount);
      const busy = txCount !== null && txCount >= SERVICE_TX_COUNT;
      const tail = busy
        ? ', such as an exchange, bridge or router. That says nothing about who is behind the wallet.'
        : '. A contract is not a person: it links this creator to no one, and says nothing about who is behind the wallet.';
      facts.push(
        viaTool
          ? `That sender is ${what}${tail}`
          : `The creator wallet was first funded from ${what}${tail}`,
      );
      return fundingFinding('quiet', facts, limits, display(0, null, 0));
    }
    if (kind !== 'wallet') {
      if (!viaTool) facts.push(`The creator wallet was first funded by ${who}.`);
      limits.push(
        'what that address is (an exchange, another service or a private wallet) could not be read, so other creators it funded are not counted',
      );
      return fundingFinding('unknown', facts, limits, display(0, null, 0));
    }

    const tx = txCount !== null ? `, ${plural(txCount, 'transaction')}` : '';
    // The network walk, when it found more than the direct count, says more.
    const walked = network && network.creators >= funding.otherCreatorsFunded ? network : undefined;
    const linked = walked ? walked.creators : funding.otherCreatorsFunded;
    if (network?.incomplete && network.reason) {
      limits.push(`the funding chain could not be followed further: ${network.reason}`);
    }
    if (walked?.capped) limits.push('only the first linked creators were counted: there are more');
    if (linked === 0) {
      facts.push(
        viaTool
          ? `That sender is a wallet (${txCount !== null ? plural(txCount, 'transaction') : 'transaction count not read'}).`
          : `The creator wallet was first funded by ${who}${tx}.`,
      );
      if (funding.otherCreatorsChecked === false) {
        limits.push('whether that wallet funded other token creators was not looked up');
      } else {
        facts.push('No other token creator funded by that wallet is on record.');
      }
      return fundingFinding('quiet', facts, limits, display(0, null, walked?.depth ?? 1));
    }
    const depth = walked?.depth ?? 1;
    const steps = depth > 1 ? `, linked through ${depth} funding steps` : '';
    const launches = walked ? walked.launches : null;
    facts.push(
      `The wallet that funded the creator (${who}${tx}) also funded ${plural(linked, 'other token creator')}${steps}.` +
        (launches !== null && launches > 0
          ? ` Together they launched ${plural(launches, 'token')}.`
          : ''),
    );
    if (walked && launches !== null && launches > 0) {
      const pads = Object.entries(walked.launchpads)
        .map(([pad, n]) => `${n} on ${launchpadProse(pad)}`)
        .join('; ');
      if (pads) facts.push(`Their launches: ${pads}.`);
    } else if (!walked) {
      limits.push('the tokens those creators launched were not counted');
    }
    return fundingFinding('concern', facts, limits, display(linked, launches, depth), [
      'creator-history',
    ]);
  },
};

const nameClone: Specialist = {
  id: 'name-clone',
  title: 'Name Clone',
  question: 'Does the token borrow a name it does not own, or reuse an earlier token’s name?',
  run({ market, index, tokenBeacon, report }: SpecialistContext): Finding {
    if (!market) return unknown('name-clone', namesNotCompared(report));
    const { name, symbol } = market;
    const limits: string[] = [];
    if (!name && !symbol) return unknown('name-clone', 'name and symbol could not be read');

    const facts = [`Name ${quoteName(name)}, symbol ${quoteName(symbol)}.`];
    let signal: Signal = 'quiet';

    // Le nom est une donnée. S'il s'adresse à un logiciel, c'est en soi un fait.
    if ((name && addressesSoftware(name)) || (symbol && addressesSoftware(symbol))) {
      facts.push(
        'The name contains wording addressed to automated software rather than to people.',
      );
      signal = 'concern';
    }

    const imitated = imitatedName(name) ?? imitatedName(symbol);
    const family = tokenBeacon ? RECOGNISED_BEACONS[tokenBeacon] : undefined;
    if (imitated && family) {
      // Un vrai token action porte aussi « Robinhood » dans son nom. Le
      // signaler ferait du bruit sur les actifs les plus légitimes de la chaîne.
      facts.push(
        `The name uses "${imitated}". The token shares its code family (beacon ${tokenBeacon}) with ${family}.`,
      );
      limits.push('who deployed that code family was not verified independently here');
      signal = 'observation';
    } else if (imitated) {
      facts.push(
        `The name uses "${imitated}", but the token does not belong to the code family of the issued Robinhood tokens.`,
      );
      signal = 'concern';
    }

    const named = index?.all().some((m) => m.name || m.symbol) ?? false;
    if (index && !named) limits.push('earlier names were not compared: the index holds no names');
    if (index && named) {
      // An emoji- or digit-only name normalises to "": two of them are not a match.
      const mine = [name, symbol]
        .filter(Boolean)
        .map((s) => normalizeName(s as string))
        .filter((n) => n.length > 0);
      const earlier = index
        .all()
        .filter((m) => m.token !== market.token && m.blockNumber < market.blockNumber)
        .filter((m) =>
          [m.name, m.symbol].filter(Boolean).some((s) => mine.includes(normalizeName(s as string))),
        );
      if (earlier.length > 0) {
        facts.push(
          `${earlier.length} earlier market(s) in the index used the same name or symbol.`,
        );
        signal = 'concern';
      }
    }
    return finding(
      'name-clone',
      signal,
      facts,
      index ? limits : [...limits, 'earlier names were not compared: index not loaded'],
    );
  },
};

const holderSpread: Specialist = {
  id: 'holder-spread',
  title: 'Holder Spread',
  question: 'How much of the supply sits in a few wallets?',
  run({ report, token }: SpecialistContext): Finding {
    const holders = report?.holders;
    if (!holders || holders.completeness === 'unavailable') {
      return unknown('holder-spread', holders?.sources[0]?.note ?? 'holder data not collected');
    }
    const { top1, top10 } = holders.data.concentration;
    const count = holders.data.holderCount;
    const pooled = holders.data.pooledShare ?? null;
    const largest = holders.data.top.find((h) => h.kind === 'wallet' || h.kind === 'contract');
    const creator = report?.creator.data.creator.toLowerCase();
    // What the largest holder is, said: a contract is not "a wallet".
    const what = !largest
      ? ''
      : creator && largest.address.toLowerCase() === creator
        ? ' (the creator)'
        : largest.name
          ? ` (${largest.name}, ${largest.address})`
          : largest.kind === 'contract'
            ? ' (a contract)'
            : ' (a wallet)';
    // A lock is not anyone's position: said with what it locks, and until when.
    const roles = report?.roles ?? [];
    const locks = (holders.data.setAside ?? [])
      .filter((s) => s.role === 'vesting')
      .map((s) => ({ s, named: roles.find((r) => r.address === s.address.toLowerCase()) }));
    const lockFacts = locks.map(({ s, named }) => {
      const lock = named?.lock;
      const manager =
        lock && (lock.cancelable || lock.withdrawable)
          ? ` Its manager${lock.owner ? ` (${roles.find((r) => r.address === lock.owner)?.name ?? lock.owner})` : ''} can still ${[lock.cancelable ? 'cancel schedules' : '', lock.withdrawable ? 'withdraw the deposit' : ''].filter(Boolean).join(' and ')}.`
          : '';
      return `${s.share !== null ? pctBounded(s.share) : 'Part'} of the supply is in ${s.name ?? 'a vesting lock'} (${s.address})${lock ? `: ${lockWords(lock, creator)}` : ''}. It is left out of the shares below, as it cannot be sold before it unlocks.${manager}`;
    });
    // The other holders the chain names: a launchpad's wallet is not a stranger.
    const namedFacts = holders.data.top
      .filter((h) => (h.kind === 'wallet' || h.kind === 'contract') && h.name)
      .slice(0, 3)
      .map((h) => {
        const detail = roles.find((r) => r.address === h.address.toLowerCase())?.detail;
        return `${h.address} is ${h.name}, with ${pct(h.share)} of the supply held outside pools and locks${detail ? `: ${detail}` : '.'}`;
      });
    const facts = [
      // How much circulates at all comes first: 70 % of 1 % is not 70 % of the token.
      ...(pooled !== null && pooled > 0
        ? [
            `${pctBounded(pooled)} of the whole supply sits in ${whereSetAside(holders.data.setAside)} and is left out: only ${pctBounded(1 - pooled)} is held outside ${/(curve|contract)$/.test(whereSetAside(holders.data.setAside)) ? 'it' : 'them'}.`,
          ]
        : []),
      ...lockFacts,
      ...(largest
        ? [
            `The largest holder${what} has ${pct(top1)} of the supply held outside pools${locks.length > 0 ? ' and locks' : ''}; the top 10 have ${pct(top10)}.`,
          ]
        : ['No address holds any of the supply outside pools and launch contracts.']),
      ...namedFacts,
      ...(count !== null ? [`${count} holder addresses in total.`] : []),
    ];
    // Thousands of holders who were sent the token by its creator are an
    // airdrop, not thousands of buyers: said, and never read as a spread.
    const own = report?.creator.data.tokens.find(
      (t) => String(t.address).toLowerCase() === token.toLowerCase(),
    );
    const fromCreator = own?.creatorRecipients ?? null;
    const airdropped = mostHoldersFromCreator(fromCreator, count);
    const links = holders.data.creatorLinks;
    if (airdropped) {
      facts.push(
        `The creator sent this token directly to ${addresses(fromCreator ?? 0)}: most of the holders received it from the creator rather than buying it.`,
      );
    } else if (fromCreator !== null && fromCreator > 0) {
      // Every recipient, or their count and total: "the only transfer" must
      // not be readable into a list that leaves one out (WAFER).
      const listed = links?.recipients ?? [];
      const total =
        links?.sentShare !== undefined
          ? `, ${pctBounded(links.sentShare)} of the supply in all`
          : '';
      const named =
        listed.length > 0
          ? `: ${listed.map((r) => `${r.address} (${pctBounded(r.share)}${r.listed ? ', still a holder' : ''})`).join(', ')}${fromCreator > listed.length ? `, and ${fromCreator - listed.length} more` : ''}`
          : '';
      facts.push(
        `Outside its markets and burn addresses, the creator sent this token directly to ${addresses(fromCreator)}${total}${named}.`,
      );
    }
    // Who among today's holders received from the creator: said, not left
    // to be guessed (AGEM, moon, DELTA: the largest holder did).
    if (links) {
      const linked = holders.data.top.filter((h) => h.fromCreator);
      for (const h of linked.slice(0, 3)) {
        const f = h.fromCreator!;
        facts.push(
          f.via
            ? `Holder ${h.address} received ${pctBounded(f.share)} of the supply from ${f.via}, a contract the creator sent tokens to.`
            : `Holder ${h.address} received ${pctBounded(f.share)} of the supply directly from the creator.`,
        );
      }
      for (const d of links.distributors) {
        facts.push(
          `The creator sent ${pctBounded(d.share)} of the supply to the contract ${d.address}, which passed it on to ${d.recipients} addresses.`,
        );
      }
      if (links.burned >= 0.001) {
        facts.push(`The creator sent ${pctBounded(links.burned)} of the supply to a burn address.`);
      }
    }
    const limits = [
      `Pools, launch curves, launch contracts${locks.length > 0 ? ', vesting locks' : ''} and burn addresses are excluded; shares are over the holders actually fetched.`,
    ];
    if (top1 >= TOP1_CONCERN || top10 >= TOP10_CONCERN) {
      return finding('holder-spread', 'concern', facts, limits, ['creator-history']);
    }
    if (airdropped) return finding('holder-spread', 'observation', facts, limits);
    if (top10 < TOP10_SPREAD && count !== null && count >= SPREAD_MIN_HOLDERS) {
      return finding('holder-spread', 'reassurance', facts, limits);
    }
    return finding('holder-spread', 'quiet', facts, limits);
  },
};

const creatorHistory: Specialist = {
  id: 'creator-history',
  title: 'Creator History',
  question: 'What happened to the creator’s previous tokens?',
  run({ report, token }: SpecialistContext): Finding {
    const creator = report?.creator;
    if (!creator || creator.completeness === 'unavailable') {
      return unknown(
        'creator-history',
        creator?.sources[0]?.note ?? 'creator history not collected',
      );
    }
    const others = creator.data.tokens.filter(
      (t) => t.address.toLowerCase() !== token.toLowerCase(),
    );
    const limits =
      creator.completeness === 'partial'
        ? [creator.sources.find((s) => s.note)?.note ?? 'partial history']
        : [];
    // A listing that failed this time leaves the other launches unknown:
    // never "no other launch" (AI: said of a creator with 80).
    const unread = readFailed(report?.failedReads, 'creator-launches');
    if (unread) {
      const why = report?.failedReads?.find((f) => f.read === 'creator-launches')?.note;
      limits.splice(0, limits.length, ...(why ? [why] : []));
      limits.push('some of the creator’s launches could not be read this time: there may be more');
    }
    if (others.length === 0) {
      if (unread) {
        return finding(
          'creator-history',
          'unknown',
          [],
          [
            'whether the creator launched other tokens could not be read this time',
            ...limits.slice(0, 1),
          ],
        );
      }
      return finding(
        'creator-history',
        'quiet',
        ['No other launch by this creator in the scanned range.'],
        limits,
      );
    }
    const pulled = others.filter((t) => t.liquidityPulled === true).length;
    const dumped = others.filter((t) => t.creatorDumped === true).length;
    const graduated = others.filter((t) => t.outcome === 'graduated').length;
    // Counted over the other launches only: the most recent checked include
    // this one, which ASTEROID's answer counted as "other" (10 of 10).
    const salesChecked = others.filter((t) => t.creatorDumped !== null).length;
    const liquidityChecked = others.filter((t) => t.liquidityPulled !== null).length;
    // Which launches those are, launchpad by launchpad (AI: the ten checked
    // were its latest Doppler launches, its pons ones, with sales, unread).
    const by = checkedByLaunchpad(creator.data, token);
    const which = (signal: 'sales' | 'liquidity') =>
      by.length > 0 ? `: ${joinClauses(checkedWords(by, signal))}` : '';
    const facts = [
      `The creator launched ${others.length} other token(s): ${graduated} graduated; ` +
        `the creator sold into the pool on ${dumped} of the ${salesChecked} checked for sales${which('sales')}; ` +
        (liquidityChecked > 0
          ? `liquidity was removed on ${pulled} of the ${liquidityChecked} checked for removals${which('liquidity')}`
          : 'liquidity removals could not be checked on them') +
        ` (each in the first ${OTHER_LAUNCH_SALES_DAYS} days after its launch; this token not counted).`,
    ];
    if (pulled + dumped > 0) return finding('creator-history', 'concern', facts, limits);
    if (graduated > 0) return finding('creator-history', 'reassurance', facts, limits);
    return finding('creator-history', 'quiet', facts, limits);
  },
};

const sellPath: Specialist = {
  id: 'sell-path',
  title: 'Sell Path',
  question: 'Can holders sell, and can the trading rules (hook) stand in the way?',
  run(context: SpecialistContext): Finding {
    const { hook, report, market } = context;
    if (context.mainRulesUnread) return unknown('sell-path', MAIN_UNREAD);
    const txns = report?.market.data.txns?.h24 ?? null;
    const trades = txns
      ? [`${txns.sells} sell(s) and ${txns.buys} buy(s) went through in the last 24 hours.`]
      : [];
    if (market && hook === null) {
      // A v4 pool without a hook: nothing sits between a sell and that pool.
      // Another pool with a hook is said beside it, and the answer is then
      // no reassurance: a sell routed there passes through its rules.
      const others = otherHooks(context);
      if (others.length > 0) {
        return finding(
          'sell-path',
          'observation',
          [
            `${mainSubject(context)} has no trading rules (hook): no contract sits between a sell in that pool and the pool.`,
            ...otherPoolLines(context, null),
            ...trades,
          ],
          txns ? [] : ['recent trades were not collected'],
          ['rule-change'],
        );
      }
      return finding(
        'sell-path',
        'reassurance',
        [
          'This token’s Uniswap v4 pool has no trading rules (hook): no contract sits between a sell and the pool.',
          ...trades,
        ],
        txns ? [] : ['recent trades were not collected'],
      );
    }
    if (hook === undefined || hook === null) {
      // Not looked up (the lookups ran out of time): nothing is said of the rules.
      if (market === undefined && context.mainPool === undefined) {
        return unknown('sell-path', 'the trading rules of this token’s pools were not read');
      }
      const where = marketElsewhere(report);
      if (!where) return unknown('sell-path', noV4Market(report));
      const others = otherPoolLines(context, null);
      const pair = pairMarket(report);
      const facts = [
        pair
          ? `Its main market is a Uniswap ${pair.version ?? 'v2/v3'} pair (${pair.label}): it has no trading-rules contract that could stand in the way of a sale.`
          : `No Uniswap v4 trading rules (hook) sit in front of trades in its main pool: this token trades on ${where}.`,
        ...others,
      ];
      if (otherHooks(context).length > 0) {
        return finding(
          'sell-path',
          'observation',
          [...facts, ...trades],
          ['the main pool’s own contract is not read here'],
        );
      }
      if (txns && txns.sells > 0) {
        return finding(
          'sell-path',
          'quiet',
          [...facts, ...trades],
          [
            'the pool’s own contract is not read here; recent sells show that selling worked in that window',
          ],
        );
      }
      return finding('sell-path', 'unknown', facts, [
        txns
          ? 'no sell went through in the last 24 hours, so whether selling works is not shown either way'
          : 'recent trades were not collected, so whether selling works is not shown',
      ]);
    }
    const ids = new Set(hook.capabilities.map((c) => c.id));
    const facts: string[] = [];
    const limits = hook.inconsistent.length
      ? [
          'the permission bits of the trading rules (hook) are inconsistent with the Uniswap v4 spec; this reading is unreliable',
        ]
      : [];
    if (txns)
      facts.push(
        `${txns.sells} sell(s) and ${txns.buys} buy(s) went through in the last 24 hours.`,
      );
    else limits.push('recent trades were not collected');

    // The other pools come last: the lines above are about the main pool's rules.
    const others = otherPoolLines(context, hook.hook);
    if (ids.has('alters-swap-amounts')) {
      facts.push(
        'The trading rules (hook) may change the amount of any trade, which gives them the power to take a cut of a sell or to stop it; what they do with that power is not readable from their permissions.',
      );
      if (txns && txns.buys >= 10 && txns.sells === 0) {
        facts.push('No sell has gone through despite repeated buys.');
        return finding('sell-path', 'concern', [...facts, ...others], limits, ['rule-change']);
      }
      return finding('sell-path', 'observation', [...facts, ...others], limits, ['rule-change']);
    }
    if (ids.has('intercepts-swaps')) {
      facts.push(
        'The trading rules (hook) are called on every trade but cannot change trade amounts.',
      );
      return finding('sell-path', 'quiet', [...facts, ...others], limits);
    }
    facts.push('The trading rules (hook) have no permission over trades.');
    return finding(
      'sell-path',
      others.some((l) => /runs trading rules|could not be read/.test(l))
        ? 'observation'
        : 'reassurance',
      [...facts, ...others],
      limits,
    );
  },
};

const volumeReality: Specialist = {
  id: 'volume-reality',
  title: 'Volume Reality',
  question: 'Does the trading come from many people, or from a few addresses going back and forth?',
  run({ report }: SpecialistContext): Finding {
    const market = report?.market;
    if (!market || market.completeness === 'unavailable' || !market.data.txns) {
      return unknown('volume-reality', market?.sources[0]?.note ?? 'market activity not collected');
    }
    const { buys, sells } = market.data.txns.h24;
    const trades = buys + sells;
    const perTrade = volumePerTrade(market);
    // Counted by the indexer from the launch pool's swaps when no pair is listed.
    const activity = market.data.activity;
    const limits: string[] = [];
    if (activity) {
      const from = activity.coveredFrom ? Date.parse(activity.coveredFrom) : NaN;
      const dayBefore = Date.parse(report.collectedAt) - 86_400_000;
      if (Number.isFinite(from) && from > dayBefore) {
        limits.push(
          `the launch pool’s swaps are counted only from ${activity.coveredFrom}, less than 24 hours`,
        );
      }
    }
    const facts = [
      `${trades} trades in 24 hours` +
        (activity ? ' in the token’s launch pool, counted from the pool’s own swaps' : '') +
        (perTrade !== null ? `, averaging ${perTrade.toFixed(2)} USD each.` : '.'),
    ];
    if (trades < MIN_TRADES_FOR_VOLUME) {
      return finding('volume-reality', 'quiet', facts, [
        ...limits,
        'too few trades to say anything about their origin',
      ]);
    }
    const traders = activity?.h24.traders ?? report?.holders.data.distinctTraders ?? null;
    if (traders !== null) {
      facts.push(`They came from ${traders} distinct address(es).`);
      if (traders / trades < TRADERS_PER_TRADE_CONCERN) {
        return finding('volume-reality', 'concern', facts, limits, ['holder-spread']);
      }
      return finding('volume-reality', 'quiet', facts, limits);
    }
    return finding('volume-reality', 'quiet', facts, [...limits, 'distinct traders not collected']);
  },
};

const liquidityMove: Specialist = {
  id: 'liquidity-move',
  title: 'Liquidity Move',
  question: 'Has liquidity been taken out, and can the trading rules (hook) touch withdrawals?',
  run({ report, token, hook }: SpecialistContext): Finding {
    const facts: string[] = [];
    const limits: string[] = [];
    const self = report?.creator.data.tokens.find(
      (t) => t.address.toLowerCase() === token.toLowerCase(),
    );
    let signal: Signal = 'unknown';
    // Two different things, said apart: liquidity the creator (or the launch
    // position) took out, and other providers taking back their own
    // positions. Said together as "no removal" next to a list of removals,
    // the text called them a contradiction (MUT8, HYPURRT, WAFER, OWN, moon).
    const deployer = report?.creator.data.origin?.source === 'deployer';
    const whose = deployer ? 'sent by the creator' : 'from the launch position';
    if (self?.liquidityPulled === true) {
      facts.push(
        deployer
          ? 'The creator removed liquidity from this token’s pool: a removal transaction it sent.'
          : 'Liquidity has already been removed from this token’s launch position.',
      );
      signal = 'concern';
    } else if (self?.liquidityPulled === false) {
      facts.push(
        `No liquidity removal ${whose} was observed on this token’s pool in the first ${OTHER_LAUNCH_SALES_DAYS} days after its launch.`,
      );
      signal = 'quiet';
    } else {
      limits.push(`liquidity removals ${whose} on this token were not determined`);
    }
    const creator = report?.creator.data.creator.toLowerCase();
    const byOthers = (self?.liquidityRemovals ?? []).filter(
      (r) => r.sender.toLowerCase() !== creator,
    );
    if (byOthers.length > 0) {
      const ownBack = byOthers.every((r) =>
        r.returned.every((x) => x.address.toLowerCase() === r.sender.toLowerCase()),
      );
      facts.push(
        `Separately, other liquidity providers removed liquidity they had added themselves: ${plural(byOthers.length, 'removal')} among the most recent read, sent by ${[...new Set(byOthers.map((r) => r.sender))].join(', ')}${ownBack ? ', the tokens going back to the address that removed them' : ''}. These are their own positions, not the creator’s or the launch liquidity: they do not contradict what is said of the creator’s liquidity.`,
      );
    }
    // Fees taken out of the market's position are tokens the creator
    // withdrew from it, without removing the liquidity itself.
    const taken = self?.feesTaken;
    if (taken && taken.transfers > 0) {
      // Summed over every transfer the market's trading rules made to the
      // creator, whenever it came (MEME: 28 transfers, 0.52 %).
      facts.push(
        `The creator received ${pctBounded(taken.share)} of the supply from ${feePayerWords(taken.payers, taken.hooks)}, in ${plural(taken.transfers, 'transfer')}: trading fees taken out of the market without removing its liquidity.`,
      );
      if (signal === 'quiet' || signal === 'unknown') signal = 'observation';
    } else if (self?.feesCollected === true) {
      facts.push(
        'The creator collected trading fees from this token’s liquidity position, taking tokens out of the market without removing its liquidity.',
      );
      if (signal === 'quiet' || signal === 'unknown') signal = 'observation';
    }

    if (hook) {
      const ids = new Set(hook.capabilities.map((c) => c.id));
      if (ids.has('alters-liquidity-removal')) {
        facts.push('The trading rules (hook) may change what comes out of a liquidity withdrawal.');
        if (signal !== 'concern') signal = 'observation';
      } else if (ids.has('intercepts-liquidity-removal')) {
        facts.push('The trading rules (hook) are called whenever liquidity is withdrawn.');
        if (signal === 'unknown') signal = 'quiet';
      }
    }
    return finding('liquidity-move', signal, facts, limits);
  },
};

const ruleChange: Specialist = {
  id: 'rule-change',
  title: 'Rule Change',
  question: 'Can the trading rules (hook) be rewritten after people have bought?',
  run(context: SpecialistContext): Finding {
    const { market, hookCode, report } = context;
    if (context.mainRulesUnread) return unknown('rule-change', MAIN_UNREAD);
    const others = otherHooks(context);
    const othersUnchecked = 'The code of the other pools’ trading rules is not checked here.';
    if (!market) {
      if (others.length > 0 && context.mainPool) {
        return finding(
          'rule-change',
          'observation',
          [
            `The main pool of this token (${poolLabel(context.mainPool.id)}) is a Uniswap ${context.mainPool.version ?? 'v2/v3'} pair, with no trading rules (hook) to rewrite.`,
            ...otherPoolLines(context, null),
          ],
          [othersUnchecked],
        );
      }
      return v4Only('rule-change', report);
    }
    if (market.hook === NATIVE) {
      // Only the absence of a hook is checked: the token's own contract may
      // still be upgradeable or carry an owner's powers (MEME's text read
      // "nothing can be rewritten later" into this).
      if (others.length > 0) {
        return finding(
          'rule-change',
          'observation',
          [
            `${mainSubject(context)} has no trading rules (hook), so that pool has no hook to rewrite.`,
            ...otherPoolLines(context, null),
          ],
          [othersUnchecked, 'Whether the token’s own contract can be changed is not checked here.'],
        );
      }
      return finding(
        'rule-change',
        'quiet',
        ['This market has no trading rules (hook), so there is no hook to rewrite.'],
        [
          'Only the market’s trading rules are checked: whether the token’s own contract can be changed is not checked here.',
        ],
      );
    }
    if (!hookCode || hookCode.codeSize === null) {
      return unknown('rule-change', 'the code of the trading rules (hook) could not be read');
    }
    const differing = otherPoolLines(context, market.hook);
    const limits = [
      'Only the standard upgrade slot (EIP-1967) is checked; other upgrade patterns exist.',
      ...(others.some((p) => p.hook !== market.hook) ? [othersUnchecked] : []),
    ];
    if (hookCode.codeSize === 0) {
      return finding(
        'rule-change',
        'concern',
        ['No code is deployed at the address of the trading rules (hook).'],
        limits,
      );
    }
    if (hookCode.implementation) {
      const facts = [
        `The trading rules (hook) are an upgradeable proxy: their code currently lives at ${hookCode.implementation} and can be replaced without changing address.`,
      ];
      if (hookCode.admin) facts.push(`The upgrade admin is ${hookCode.admin}.`);
      return finding('rule-change', 'concern', [...facts, ...differing], limits);
    }
    return finding(
      'rule-change',
      'reassurance',
      [
        `The code of the trading rules (hook) (${hookCode.codeSize} bytes) has no standard upgrade slot set.`,
        ...differing,
      ],
      limits,
    );
  },
};

export const CATALOG: Record<SpecialistId, Specialist> = {
  'code-reuse': codeReuse,
  'wallet-age': walletAge,
  'funding-trace': fundingTrace,
  'name-clone': nameClone,
  'holder-spread': holderSpread,
  'creator-history': creatorHistory,
  'sell-path': sellPath,
  'volume-reality': volumeReality,
  'liquidity-move': liquidityMove,
  'rule-change': ruleChange,
};
