/**
 * "Sources & limitations" under the reading: one entry per source, under a
 * plain name, with every limit its reads reported, each once. A source says
 * "no limitations" only when none of its reads had one.
 */

/** The sources' names as the reader knows them. */
const SOURCE_NAMES: Record<string, string> = {
  'solana-rpc': 'Solana',
  'dexscreener-solana': 'DexScreener',
};

export function sourceName(source: string): string {
  return SOURCE_NAMES[source] ?? source;
}

/**
 * The Solana view's blocks whose partial reads join the list: the market is
 * DexScreener's, every other one the Solana node's.
 */
const VIEW_BLOCKS = [
  'mint',
  'creator',
  'onToken',
  'history',
  'linked',
  'holders',
  'market',
  'launchpad',
  'graduation',
  'liquidity',
  'launch',
] as const;

type ViewBlocks = {
  [K in (typeof VIEW_BLOCKS)[number]]?: { read: string; note?: string } | null;
};

export type SourceLimits = { source: string; name: string; limits: string[] };

export function sourceLimits(
  sources: readonly { name: string; note?: string }[],
  view?: ViewBlocks | null,
  plain: (note: string) => string | undefined = (note) => note,
): SourceLimits[] {
  const groups = new Map<string, SourceLimits>();
  const add = (source: string, note: string | undefined) => {
    let group = groups.get(source);
    if (!group) {
      group = { source, name: sourceName(source), limits: [] };
      groups.set(source, group);
    }
    const limit = note ? plain(note) : undefined;
    if (limit && !group.limits.includes(limit)) group.limits.push(limit);
  };
  for (const source of sources) add(source.name, source.note);
  // A read that was only partly made is a limit too (the launch replay's
  // window, most often), even when the block's source said nothing.
  for (const key of VIEW_BLOCKS) {
    const block = view?.[key];
    if (block?.read === 'partial' && block.note) {
      add(key === 'market' ? 'dexscreener-solana' : 'solana-rpc', block.note);
    }
  }
  return [...groups.values()];
}
