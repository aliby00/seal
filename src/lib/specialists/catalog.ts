import { NATIVE } from '../chain/pools';
import { MAX_BEHAVIOR_TOKENS } from '../chain';
import { volumePerTrade } from '../market';
import { addressesSoftware, imitatedName, normalizeName, quoteName } from './names';
import type { FunderKind } from '../chain/funder-kind';
import type {
  Finding,
  FundingDisplay,
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

const codeReuse: Specialist = {
  id: 'code-reuse',
  title: 'Code Reuse',
  question: 'Have this market’s trading rules (hook) already been used by other markets?',
  run({ market, index, report }: SpecialistContext): Finding {
    if (!market) return unknown('code-reuse', noV4Market(report));
    if (market.hook === NATIVE) {
      return finding('code-reuse', 'quiet', ['This market runs without trading rules (no hook).']);
    }
    if (!index || index.size === 0) {
      return unknown('code-reuse', 'the cross-market index was not loaded');
    }
    const siblings = index.onHook(market.hook).filter((m) => m.id !== market.id);
    const range = index.all();
    const window = `blocks ${range[0]?.blockNumber} to ${range.at(-1)?.blockNumber}`;
    if (siblings.length + 1 < REUSE_NOTABLE) {
      return finding('code-reuse', 'quiet', [
        `The trading rules (hook) ${market.hook} are used by ${siblings.length + 1} market(s) in the indexed window (${window}).`,
      ]);
    }
    const facts = [
      `The trading rules (hook) ${market.hook} are shared by ${siblings.length + 1} markets in the indexed window (${window}).`,
    ];
    const tokens = new Set(siblings.map((s) => s.token));
    facts.push(`Those markets list ${tokens.size} distinct other token(s).`);
    const judged = siblings.filter((s) => s.outcome === 'harmed' || s.outcome === 'unharmed');
    const harmed = judged.filter((s) => s.outcome === 'harmed').length;
    const limits = [
      'Shared trading rules can be a launchpad’s standard ones; reuse alone does not say what they do.',
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
    if (launched !== undefined)
      facts.push(`It launched ${launched} token(s) in the scanned range.`);
    if (creatorNonce <= FRESH_WALLET_NONCE) {
      facts.push('This launch is among the very first actions of that wallet.');
      return finding('wallet-age', 'concern', facts, [], ['funding-trace']);
    }
    return finding('wallet-age', 'quiet', facts);
  },
};

const plural = (n: number, word: string) =>
  `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

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
      const what = `${contractName(name)}${txCount !== null ? `, ${plural(txCount, 'transaction')}` : ''}`;
      facts.push(
        viaTool
          ? `That sender is a high-volume service (${what}), such as an exchange, bridge or router. That says nothing about who is behind the wallet.`
          : `The creator wallet was first funded from a high-volume service (${what}), such as an exchange, bridge or router. That says nothing about who is behind the wallet.`,
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
        .map(([pad, n]) => `${pad} ${n}`)
        .join(', ');
      if (pads) facts.push(`Their launches by launchpad: ${pads}.`);
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
  run({ report }: SpecialistContext): Finding {
    const holders = report?.holders;
    if (!holders || holders.completeness === 'unavailable') {
      return unknown('holder-spread', holders?.sources[0]?.note ?? 'holder data not collected');
    }
    const { top1, top10 } = holders.data.concentration;
    const count = holders.data.holderCount;
    const facts = [
      `The largest holder has ${pct(top1)} of counted supply; the top 10 have ${pct(top10)}.`,
      ...(count !== null ? [`${count} holder addresses in total.`] : []),
    ];
    const limits = [
      'Pool and burn addresses are excluded; shares are over the holders actually fetched.',
    ];
    if (top1 >= TOP1_CONCERN || top10 >= TOP10_CONCERN) {
      return finding('holder-spread', 'concern', facts, limits, ['creator-history']);
    }
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
    if (others.length === 0) {
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
    const facts = [
      `The creator launched ${others.length} other token(s): ${graduated} graduated, ${pulled} saw liquidity removed, ${dumped} saw the creator sell into the pool (sales and removals checked on the ${MAX_BEHAVIOR_TOKENS} most recent, in the ~11 days after each launch).`,
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
  run({ hook, report, market }: SpecialistContext): Finding {
    if (market && hook === null) {
      // A v4 pool without a hook: nothing sits between a sell and the pool.
      const txns = report?.market.data.txns?.h24 ?? null;
      const facts = [
        'This token’s Uniswap v4 pool has no trading rules (hook): no contract sits between a sell and the pool.',
      ];
      if (txns)
        facts.push(
          `${txns.sells} sell(s) and ${txns.buys} buy(s) went through in the last 24 hours.`,
        );
      return finding(
        'sell-path',
        'reassurance',
        facts,
        txns ? [] : ['recent trades were not collected'],
      );
    }
    if (hook === undefined || hook === null) {
      const where = marketElsewhere(report);
      const txns = report?.market.data.txns?.h24 ?? null;
      if (!where) return unknown('sell-path', noV4Market(report));
      const facts = [
        `No Uniswap v4 trading rules (hook) sit in front of trades: this token trades on ${where}.`,
      ];
      if (txns && txns.sells > 0) {
        facts.push(
          `${txns.sells} sell(s) and ${txns.buys} buy(s) went through in the last 24 hours.`,
        );
        return finding('sell-path', 'quiet', facts, [
          'the pool’s own contract is not read here; recent sells show that selling worked in that window',
        ]);
      }
      return finding('sell-path', 'unknown', facts, [
        txns
          ? 'no sell went through in the last 24 hours, so whether selling works is not shown either way'
          : 'recent trades were not collected, so whether selling works is not shown',
      ]);
    }
    const ids = new Set(hook.capabilities.map((c) => c.id));
    const txns = report?.market.data.txns?.h24 ?? null;
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

    if (ids.has('alters-swap-amounts')) {
      facts.push(
        'The trading rules (hook) may change the amount of any trade, which gives them the power to take a cut of a sell or to stop it; what they do with that power is not readable from their permissions.',
      );
      if (txns && txns.buys >= 10 && txns.sells === 0) {
        facts.push('No sell has gone through despite repeated buys.');
        return finding('sell-path', 'concern', facts, limits, ['rule-change']);
      }
      return finding('sell-path', 'observation', facts, limits, ['rule-change']);
    }
    if (ids.has('intercepts-swaps')) {
      facts.push(
        'The trading rules (hook) are called on every trade but cannot change trade amounts.',
      );
      return finding('sell-path', 'quiet', facts, limits);
    }
    facts.push('The trading rules (hook) have no permission over trades.');
    return finding('sell-path', 'reassurance', facts, limits);
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

    if (self?.liquidityPulled === true) {
      facts.push('Liquidity has already been removed from this token’s pool.');
      signal = 'concern';
    } else if (self?.liquidityPulled === false) {
      facts.push(
        'No liquidity removal was observed on this token’s pool in the ~11 days after its launch.',
      );
      signal = 'quiet';
    } else {
      limits.push('liquidity removals on this token were not determined');
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
  run({ market, hookCode, report }: SpecialistContext): Finding {
    if (!market) return unknown('rule-change', noV4Market(report));
    if (market.hook === NATIVE) {
      return finding('rule-change', 'quiet', ['There are no trading rules (hook) to rewrite.']);
    }
    if (!hookCode || hookCode.codeSize === null) {
      return unknown('rule-change', 'the code of the trading rules (hook) could not be read');
    }
    const limits = [
      'Only the standard upgrade slot (EIP-1967) is checked; other upgrade patterns exist.',
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
      return finding('rule-change', 'concern', facts, limits);
    }
    return finding(
      'rule-change',
      'reassurance',
      [
        `The code of the trading rules (hook) (${hookCode.codeSize} bytes) has no standard upgrade slot set.`,
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
