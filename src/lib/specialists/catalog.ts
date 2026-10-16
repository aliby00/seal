import { NATIVE } from '../chain/pools';
import { MAX_BEHAVIOR_TOKENS } from '../chain';
import { volumePerTrade } from '../market';
import { addressesSoftware, imitatedName, normalizeName, quoteName } from './names';
import type { Finding, Signal, Specialist, SpecialistContext, SpecialistId } from './types';

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
  if (data.graduation && !data.graduation.graduated) return 'its pons launch pool';
  if (data.pair)
    return `a trading pair listed by DexScreener (${data.pair.slice(0, 6)}…${data.pair.slice(-4)})`;
  return null;
}

/** Why a v4-only question has no answer, in plain words. */
export function noV4Market(report: SpecialistContext['report']): string {
  const where = marketElsewhere(report);
  return where
    ? `this token trades on ${where}, not on a Uniswap v4 pool, so there is no v4 rulebook for this question to read`
    : 'no market was found for this token: no Uniswap v4 pool, no pons pool, and no pair listed by DexScreener';
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
  question: 'Has this market’s rulebook already been used by other markets?',
  run({ market, index, report }: SpecialistContext): Finding {
    if (!market) return unknown('code-reuse', noV4Market(report));
    if (market.hook === NATIVE) {
      return finding('code-reuse', 'quiet', ['This market runs without a rulebook (no hook).']);
    }
    if (!index || index.size === 0) {
      return unknown('code-reuse', 'the cross-market index was not loaded');
    }
    const siblings = index.onHook(market.hook).filter((m) => m.id !== market.id);
    const range = index.all();
    const window = `blocks ${range[0]?.blockNumber} to ${range.at(-1)?.blockNumber}`;
    if (siblings.length + 1 < REUSE_NOTABLE) {
      return finding('code-reuse', 'quiet', [
        `The rulebook ${market.hook} is used by ${siblings.length + 1} market(s) in the indexed window (${window}).`,
      ]);
    }
    const facts = [
      `The rulebook ${market.hook} is shared by ${siblings.length + 1} markets in the indexed window (${window}).`,
    ];
    const tokens = new Set(siblings.map((s) => s.token));
    facts.push(`Those markets list ${tokens.size} distinct other token(s).`);
    const judged = siblings.filter((s) => s.outcome === 'harmed' || s.outcome === 'unharmed');
    const harmed = judged.filter((s) => s.outcome === 'harmed').length;
    const limits = [
      'A shared rulebook can be a launchpad’s standard one; reuse alone does not say what it does.',
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

const fundingTrace: Specialist = {
  id: 'funding-trace',
  title: 'Funding Trace',
  question: 'Who paid for the creator’s wallet, and did they fund other creators?',
  run({ funding }: SpecialistContext): Finding {
    if (funding === undefined) {
      return unknown(
        'funding-trace',
        'funding was not collected — it needs an indexer key (Blockscout); the creator’s first incoming transfer cannot be found by RPC alone',
      );
    }
    if (funding === null) {
      return finding('funding-trace', 'quiet', [
        'No incoming funding transfer was found for the creator.',
      ]);
    }
    const facts = [`The creator wallet was first funded by ${funding.funder}.`];
    if (funding.otherCreatorsFunded > 0) {
      facts.push(`That same address funded ${funding.otherCreatorsFunded} other token creator(s).`);
      return finding('funding-trace', 'concern', facts, [], ['creator-history']);
    }
    return finding('funding-trace', 'quiet', facts);
  },
};

const nameClone: Specialist = {
  id: 'name-clone',
  title: 'Name Clone',
  question: 'Does the token borrow a name it does not own, or reuse an earlier token’s name?',
  run({ market, index, tokenBeacon, report }: SpecialistContext): Finding {
    if (!market) return unknown('name-clone', noV4Market(report));
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
      creator.completeness === 'partial' ? [creator.sources[0]?.note ?? 'partial history'] : [];
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
  question: 'Can holders sell, and can the rulebook stand in the way?',
  run({ hook, report, market }: SpecialistContext): Finding {
    if (market && hook === null) {
      // A v4 pool without a hook: nothing sits between a sell and the pool.
      const txns = report?.market.data.txns?.h24 ?? null;
      const facts = [
        'This token’s Uniswap v4 pool has no rulebook (hook): no contract sits between a sell and the pool.',
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
        `No Uniswap v4 rulebook sits in front of trades: this token trades on ${where}.`,
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
          'the rulebook’s permission bits are inconsistent with the Uniswap v4 spec; this reading is unreliable',
        ]
      : [];
    if (txns)
      facts.push(
        `${txns.sells} sell(s) and ${txns.buys} buy(s) went through in the last 24 hours.`,
      );
    else limits.push('recent trades were not collected');

    if (ids.has('alters-swap-amounts')) {
      facts.push(
        'The rulebook may change the amount of any trade, which gives it the power to take a cut of a sell or to stop it; what it does with that power is not readable from its permissions.',
      );
      if (txns && txns.buys >= 10 && txns.sells === 0) {
        facts.push('No sell has gone through despite repeated buys.');
        return finding('sell-path', 'concern', facts, limits, ['rule-change']);
      }
      return finding('sell-path', 'observation', facts, limits, ['rule-change']);
    }
    if (ids.has('intercepts-swaps')) {
      facts.push('The rulebook is called on every trade but cannot change trade amounts.');
      return finding('sell-path', 'quiet', facts, limits);
    }
    facts.push('The rulebook has no permission over trades.');
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
    const facts = [
      `${trades} trades in 24 hours` +
        (perTrade !== null ? `, averaging ${perTrade.toFixed(2)} USD each.` : '.'),
    ];
    if (trades < MIN_TRADES_FOR_VOLUME) {
      return finding('volume-reality', 'quiet', facts, [
        'too few trades to say anything about their origin',
      ]);
    }
    const traders = report?.holders.data.distinctTraders ?? null;
    if (traders !== null) {
      facts.push(`They came from ${traders} distinct address(es).`);
      if (traders / trades < TRADERS_PER_TRADE_CONCERN) {
        return finding('volume-reality', 'concern', facts, [], ['holder-spread']);
      }
      return finding('volume-reality', 'quiet', facts);
    }
    return finding('volume-reality', 'quiet', facts, ['distinct traders not collected']);
  },
};

const liquidityMove: Specialist = {
  id: 'liquidity-move',
  title: 'Liquidity Move',
  question: 'Has liquidity been taken out, and can the rulebook touch withdrawals?',
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
        facts.push('The rulebook may change what comes out of a liquidity withdrawal.');
        if (signal !== 'concern') signal = 'observation';
      } else if (ids.has('intercepts-liquidity-removal')) {
        facts.push('The rulebook is called whenever liquidity is withdrawn.');
        if (signal === 'unknown') signal = 'quiet';
      }
    }
    return finding('liquidity-move', signal, facts, limits);
  },
};

const ruleChange: Specialist = {
  id: 'rule-change',
  title: 'Rule Change',
  question: 'Can the rulebook be rewritten after people have bought?',
  run({ market, hookCode, report }: SpecialistContext): Finding {
    if (!market) return unknown('rule-change', noV4Market(report));
    if (market.hook === NATIVE) {
      return finding('rule-change', 'quiet', ['There is no rulebook to rewrite.']);
    }
    if (!hookCode || hookCode.codeSize === null) {
      return unknown('rule-change', 'the rulebook’s code could not be read');
    }
    const limits = [
      'Only the standard upgrade slot (EIP-1967) is checked; other upgrade patterns exist.',
    ];
    if (hookCode.codeSize === 0) {
      return finding(
        'rule-change',
        'concern',
        ['No code is deployed at the rulebook address.'],
        limits,
      );
    }
    if (hookCode.implementation) {
      const facts = [
        `The rulebook is an upgradeable proxy: its code currently lives at ${hookCode.implementation} and can be replaced without changing address.`,
      ];
      if (hookCode.admin) facts.push(`The upgrade admin is ${hookCode.admin}.`);
      return finding('rule-change', 'concern', facts, limits);
    }
    return finding(
      'rule-change',
      'reassurance',
      [`The rulebook’s code (${hookCode.codeSize} bytes) has no standard upgrade slot set.`],
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
