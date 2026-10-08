/**
 * Lecture des permissions d'un rulebook Uniswap v4.
 *
 * C'est la capacité que le produit revendique et que personne n'expose : sur
 * v4, celui qui lance un marché écrit le programme qui tourne à chaque achat
 * et à chaque vente. Ce programme est public, et illisible en pratique.
 *
 * Le point non évident : les permissions ne se lisent pas dans le contrat,
 * elles sont encodées dans **les 14 bits bas de son adresse**. v4 décide
 * d'appeler un hook en inspectant l'adresse elle-même — donc le décodage ne
 * coûte aucun appel réseau. Une adresse suffit.
 *
 * Vérifié contre Uniswap/v4-core `src/libraries/Hooks.sol` :
 *   hasPermission(self, flag) => uint160(address(self)) & flag != 0
 *   ALL_HOOK_MASK = uint160((1 << 14) - 1)
 *
 * Ce module ne dit jamais ce qu'un rulebook *fait*, seulement ce qu'il a le
 * droit de faire. La distinction est tout le propos : lire `AFTER_SWAP` prouve
 * qu'il inspecte chaque échange, pas ce qu'il en conclut.
 */

/** Les 14 drapeaux de `Hooks.sol`, du bit le plus haut au plus bas. */
export const HOOK_FLAGS = [
  ['beforeInitialize', 13],
  ['afterInitialize', 12],
  ['beforeAddLiquidity', 11],
  ['afterAddLiquidity', 10],
  ['beforeRemoveLiquidity', 9],
  ['afterRemoveLiquidity', 8],
  ['beforeSwap', 7],
  ['afterSwap', 6],
  ['beforeDonate', 5],
  ['afterDonate', 4],
  ['beforeSwapReturnsDelta', 3],
  ['afterSwapReturnsDelta', 2],
  ['afterAddLiquidityReturnsDelta', 1],
  ['afterRemoveLiquidityReturnsDelta', 0],
] as const satisfies readonly (readonly [string, number])[];

export type HookFlag = (typeof HOOK_FLAGS)[number][0];

/** `ALL_HOOK_MASK` : seuls les 14 bits bas portent des permissions. */
export const ALL_HOOK_MASK = (1 << 14) - 1;

/**
 * Un drapeau `*ReturnsDelta` n'a de sens qu'avec son drapeau de base : le hook
 * ne peut modifier le résultat d'une opération qu'il n'intercepte pas.
 * `Hooks.sol` refuse ces adresses au déploiement, donc en rencontrer une
 * signale un décodage douteux plutôt qu'un hook exotique.
 */
const REQUIRES: Partial<Record<HookFlag, HookFlag>> = {
  beforeSwapReturnsDelta: 'beforeSwap',
  afterSwapReturnsDelta: 'afterSwap',
  afterAddLiquidityReturnsDelta: 'afterAddLiquidity',
  afterRemoveLiquidityReturnsDelta: 'afterRemoveLiquidity',
};

export type HookPermissions = {
  hook: string;
  /** Les 14 bits bas de l'adresse, ce qui reste après `ALL_HOOK_MASK`. */
  mask: number;
  flags: HookFlag[];
  /** Adresse nulle ou masque vide : le marché tourne sans rulebook. */
  unhooked: boolean;
  /**
   * Drapeaux `*ReturnsDelta` orphelins. Non vide = l'adresse ne respecte pas
   * la spec, et le reste du décodage ne doit pas être présenté comme sûr.
   */
  inconsistent: HookFlag[];
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Décode les permissions portées par une adresse de hook.
 *
 * Lève sur une adresse mal formée plutôt que de renvoyer un masque vide : un
 * masque vide veut dire « ce marché n'a pas de rulebook », une affirmation
 * forte qu'on ne veut jamais produire par accident à partir d'une saisie
 * invalide.
 */
export function decodeHookPermissions(hook: string): HookPermissions {
  if (!ADDRESS.test(hook)) {
    throw new TypeError(`adresse de hook invalide : ${hook}`);
  }

  const mask = Number(BigInt(hook) & BigInt(ALL_HOOK_MASK));
  const flags = HOOK_FLAGS.filter(([, bit]) => (mask >> bit) & 1).map(([name]) => name);
  const inconsistent = flags.filter((f) => {
    const base = REQUIRES[f];
    return base !== undefined && !flags.includes(base);
  });

  return { hook: hook.toLowerCase(), mask, flags, unhooked: mask === 0, inconsistent };
}

/**
 * Ce qu'on peut dire à voix haute, à partir des permissions.
 *
 * `statement` est systématiquement une capacité — « peut », « intercepte » —
 * jamais une intention. Un rulebook autorisé à modifier le montant d'une vente
 * peut prélever des frais, bloquer la sortie, ou ne rien faire du tout. On ne
 * le sait pas, donc on ne le dit pas.
 */
export type HookCapability = {
  /** Clé stable, pour que l'agent et les tests ne dépendent pas du libellé. */
  id:
    | 'intercepts-swaps'
    | 'alters-swap-amounts'
    | 'intercepts-liquidity-removal'
    | 'alters-liquidity-removal'
    | 'intercepts-liquidity-adds'
    | 'runs-at-market-creation'
    | 'intercepts-donations';
  statement: string;
  /** Les drapeaux qui justifient cette phrase, pour pouvoir la contester. */
  because: HookFlag[];
};

type Rule = { id: HookCapability['id']; statement: string; anyOf: readonly HookFlag[] };

/**
 * Ordre volontaire : du plus conséquent pour quelqu'un qui détient le token au
 * moins conséquent. Pouvoir modifier le montant d'une vente passe avant tout
 * le reste, parce que c'est la permission qui décide si on peut sortir.
 */
const RULES: readonly Rule[] = [
  {
    id: 'alters-swap-amounts',
    statement:
      "ce rulebook peut modifier le montant d'un échange — il a donc le pouvoir de prélever sur une vente ou de l'empêcher ; ce qu'il en fait ne se lit pas dans ses permissions",
    anyOf: ['beforeSwapReturnsDelta', 'afterSwapReturnsDelta'],
  },
  {
    id: 'intercepts-swaps',
    statement: 'ce rulebook est appelé à chaque échange, achat comme vente',
    anyOf: ['beforeSwap', 'afterSwap'],
  },
  {
    id: 'alters-liquidity-removal',
    statement: "ce rulebook peut modifier ce qui sort d'un retrait de liquidité",
    anyOf: ['afterRemoveLiquidityReturnsDelta'],
  },
  {
    id: 'intercepts-liquidity-removal',
    statement: 'ce rulebook est appelé quand de la liquidité est retirée',
    anyOf: ['beforeRemoveLiquidity', 'afterRemoveLiquidity'],
  },
  {
    id: 'intercepts-liquidity-adds',
    statement: 'ce rulebook est appelé quand de la liquidité est apportée',
    anyOf: ['beforeAddLiquidity', 'afterAddLiquidity', 'afterAddLiquidityReturnsDelta'],
  },
  {
    id: 'runs-at-market-creation',
    statement: 'ce rulebook est appelé à la création du marché',
    anyOf: ['beforeInitialize', 'afterInitialize'],
  },
  {
    id: 'intercepts-donations',
    statement: 'ce rulebook est appelé sur les dons au pool',
    anyOf: ['beforeDonate', 'afterDonate'],
  },
];

export function describeHookPermissions(permissions: HookPermissions): HookCapability[] {
  if (permissions.unhooked) return [];
  return RULES.flatMap((rule) => {
    const because = rule.anyOf.filter((f) => permissions.flags.includes(f));
    return because.length ? [{ id: rule.id, statement: rule.statement, because }] : [];
  });
}

/** Décodage et mise en phrases en une fois, pour le cas courant. */
export function readHook(hook: string): HookPermissions & { capabilities: HookCapability[] } {
  const permissions = decodeHookPermissions(hook);
  return { ...permissions, capabilities: describeHookPermissions(permissions) };
}
