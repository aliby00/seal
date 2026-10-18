import { decodeAbiParameters, type Hex } from 'viem';
import type { NamedAddress, VestingLock, VestingSchedule } from '../contracts/roles';
import { isContractCode } from './code';
import { ENTRY_POINTS } from './deployer';
import { LAUNCHPADS, VIRTUALS } from './launchpads';
import type { BatchOutcome, RpcClient, RpcRequest } from './rpc';

/**
 * Names the addresses that matter to a token — its largest holders, the
 * recipients of its launch — by what they are, read on chain.
 *
 * Read on 18/10/2026 on SIRIUS (a Virtuals launch, docs/launchpads.md):
 *  - a TokenTable lock answers `version()` = "2.7.7-TTUnlocker-cancun" and
 *    `getProjectToken()` = the token; its schedules are `actuals(i)`, their
 *    beneficiaries the owners of its `futureToken()` NFTs, their shape
 *    `getEncodedPreset(presetId)`, what is due today
 *    `calculateAmountClaimable(i)`;
 *  - a pool answers `token0()` and `token1()`, one of them the token, and
 *    `fee()` (V3) or `getReserves()` (V2): SIRIUS's 5.7 % "contract" was a
 *    V3 pool against USDG that no listing names;
 *  - an ERC-4337 account answers `entryPoint()` with a known EntryPoint;
 *  - Virtuals' reserve and capital-formation wallets are wallets: they are
 *    named from the launchpad's configuration (`teamTokenReservedWallet()`)
 *    and from what they received on every launch sampled.
 */

const SELECTOR = {
  version: '0x54fd4d50',
  getProjectToken: '0x4837c596',
  futureToken: '0x3aa4327c',
  owner: '0x8da5cb5b',
  isCancelable: '0x1bffb491',
  isWithdrawable: '0x4d840bcc',
  actuals: '0x7fe3b91f',
  calculateAmountClaimable: '0x42734d45',
  getEncodedPreset: '0x2de1d431',
  ownerOf: '0x6352211e',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  fee: '0xddca3f43',
  getReserves: '0x0902f1ac',
  entryPoint: '0xb0d691fe',
  symbol: '0x95d89b41',
} as const;

/** Schedules read on one lock, at most. */
export const MAX_SCHEDULES = 6;
/** Contracts probed, at most: the largest holders and the launch's recipients. */
export const MAX_PROBED = 8;
/**
 * Calls sent together, at most. The public node lets about 20 calls through
 * at once, then about 4 a second (measured on 18/10/2026: batches of 1, 5 and
 * 10 answered, the next 15 got a 429): small batches, one after the other.
 */
export const ROLE_BATCH = 8;

/** Sends the calls in small batches, one after the other. */
async function batched(rpc: RpcClient, requests: RpcRequest[]): Promise<BatchOutcome<string>[]> {
  const out: BatchOutcome<string>[] = [];
  for (let i = 0; i < requests.length; i += ROLE_BATCH) {
    out.push(...(await rpc.callBatch<string>(requests.slice(i, i + ROLE_BATCH))));
  }
  return out;
}

/** The value of one answer, or null when it failed or is missing. */
function valueAt(answers: readonly BatchOutcome<string>[], i: number): string | null {
  const answer = answers[i];
  return answer?.ok ? answer.value : null;
}

const lower = (a: string) => a.toLowerCase();
const uint = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');
const call = (to: string, data: string): RpcRequest => ({
  method: 'eth_call',
  params: [{ to, data }, 'latest'],
});

function asAddress(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 66) return null;
  const a = `0x${raw.slice(-40)}`.toLowerCase();
  return /^0x0{40}$/.test(a) ? null : a;
}

function asBool(raw: unknown): boolean | null {
  if (typeof raw !== 'string' || raw.length < 66) return null;
  return BigInt(raw.slice(0, 66)) !== 0n;
}

/** A string return value (`version()`, `symbol()`), or null. */
export function asString(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 130) return null;
  try {
    const [value] = decodeAbiParameters([{ type: 'string' }], raw as Hex);
    return value.replace(/[^\x20-\x7e]/g, '').slice(0, 40) || null;
  } catch {
    return null;
  }
}

function words(raw: unknown): bigint[] | null {
  if (typeof raw !== 'string' || !/^0x[0-9a-f]*$/i.test(raw) || raw.length < 66) return null;
  const out: bigint[] = [];
  for (let i = 2; i + 64 <= raw.length; i += 64) out.push(BigInt(`0x${raw.slice(i, i + 64)}`));
  return out;
}

/** A TokenTable preset: linear segments, each with its share and its number of unlocks. */
export type Preset = {
  /** Seconds after the schedule's start at which each segment begins. */
  starts: number[];
  /** Seconds after the start at which the last segment ends. */
  end: number;
  /** Each segment's share, in basis points of the schedule. */
  bips: number[];
  /** Unlocks in each segment. */
  unlocks: number[];
  stream: boolean;
};

/** Decodes `getEncodedPreset(presetId)`: `(uint256[], uint256, uint256[], uint256[], bool)`, wrapped in `bytes`. */
export function decodePreset(raw: unknown): Preset | null {
  if (typeof raw !== 'string' || raw.length < 130) return null;
  try {
    const [inner] = decodeAbiParameters([{ type: 'bytes' }], raw as Hex);
    const [starts, end, bips, unlocks, stream] = decodeAbiParameters(
      [
        { type: 'uint256[]' },
        { type: 'uint256' },
        { type: 'uint256[]' },
        { type: 'uint256[]' },
        { type: 'bool' },
      ],
      inner,
    );
    if (starts.length === 0 || starts.length !== bips.length || bips.length !== unlocks.length) {
      return null;
    }
    return {
      starts: starts.map(Number),
      end: Number(end),
      bips: bips.map(Number),
      unlocks: unlocks.map(Number),
      stream,
    };
  } catch {
    return null;
  }
}

/** The moments a preset unlocks something, in seconds after the start, with what each unlocks (bips). */
export function unlockSteps(preset: Preset): { at: number; bips: number }[] {
  const steps: { at: number; bips: number }[] = [];
  preset.starts.forEach((start, i) => {
    const end = preset.starts[i + 1] ?? preset.end;
    const n = Math.max(1, preset.unlocks[i] ?? 1);
    const bips = preset.bips[i] ?? 0;
    for (let k = 1; k <= n; k += 1) {
      steps.push({ at: start + Math.round(((end - start) * k) / n), bips: bips / n });
    }
  });
  return steps;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const share6 = (value: bigint, supply: bigint) =>
  supply > 0n ? Number((value * 1_000_000n) / supply) / 1_000_000 : 0;

/** One schedule, as shares of the supply and dates. */
export function scheduleOf(input: {
  beneficiary: string | null;
  start: number;
  total: bigint;
  claimed: bigint;
  claimable: bigint;
  preset: Preset;
  supply: bigint;
}): VestingSchedule {
  const steps = unlockSteps(input.preset);
  const first = steps[0]?.at ?? 0;
  const last = steps.at(-1)?.at ?? input.preset.end;
  return {
    beneficiary: input.beneficiary,
    total: share6(input.total, input.supply),
    claimed: share6(input.claimed, input.supply),
    unlocked: share6(input.claimed + input.claimable, input.supply),
    startsAt: iso(input.start + first),
    endsAt: iso(input.start + last),
    steps: input.preset.stream ? 0 : steps.length,
  };
}

type Candidate = { address: string; isContract: boolean | null };

export type RoleContext = {
  token: string;
  /** The token's supply, the base of every share. */
  supply: bigint;
  /** The launchpad that made the token, by id, when a known one did. */
  launchpad?: string | null;
  /** The token's curve and pools, already known from its launch. */
  curves?: readonly string[];
  now?: () => Date;
};

/** "Virtuals’", "flap.sh’s": a launchpad's name as an owner. */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`;
}

/** Names known without a read: a launchpad's contracts and wallets. */
export function knownName(
  address: string,
  context: Pick<RoleContext, 'curves' | 'launchpad'>,
): NamedAddress | null {
  const a = lower(address);
  if (a === VIRTUALS.reserveWallet) {
    return {
      address: a,
      kind: 'distributor',
      name: 'Virtuals’ reserve wallet',
      detail:
        'The wallet Virtuals’ launchpad sends the reserved part of a launch to; it hands it out within minutes.',
      tradable: true,
      launchpad: 'Virtuals',
      evidence: `teamTokenReservedWallet() of Virtuals’ launch configuration ${VIRTUALS.config}`,
    };
  }
  if (a === VIRTUALS.acfWallet) {
    return {
      address: a,
      kind: 'capital-formation',
      name: 'Virtuals’ capital-formation wallet (ACF)',
      detail:
        'Virtuals’ wallet for Automated Capital Formation: it receives 25% of every launch that uses it, and sells it through pools it fills as the price rises, the proceeds going to the team. It is not locked.',
      tradable: true,
      launchpad: 'Virtuals',
      evidence:
        'received 25% of the supply from Virtuals’ reserve wallet on every ACF launch sampled (SIRIUS, UMBRA, MIKO, SYNA, POPHIE, HOUSE)',
    };
  }
  if (a === VIRTUALS.acfBatch) {
    return {
      address: a,
      kind: 'batch-sender',
      name: 'a batch contract of Virtuals’ capital-formation wallet',
      detail:
        'A contract the capital-formation wallet sends tokens through to fill its pools; what it holds is waiting to be placed in a pool.',
      tradable: true,
      launchpad: 'Virtuals',
      evidence:
        'received 70.5 M SIRIUS from the capital-formation wallet on 23/09/2026 and put 50.5 M in the V3 pool against USDG in one transaction (0x5a20a246…)',
    };
  }
  const curve = (context.curves ?? []).some((c) => lower(c) === a);
  if (curve) {
    const pad = context.launchpad ? LAUNCHPADS.find((l) => l.id === context.launchpad) : undefined;
    return {
      address: a,
      kind: 'curve',
      name: pad ? `${possessive(pad.name)} launch curve` : 'the launch curve',
      detail:
        'Where the token is first sold, before it moves to an open market: buyers buy from it, and what is left moves to the market at graduation.',
      tradable: false,
      ...(pad ? { launchpad: pad.name } : {}),
      evidence: 'named as the curve in the launch event',
    };
  }
  const pad = LAUNCHPADS.find((l) => l.address === a);
  if (pad) {
    return {
      address: a,
      kind: 'launchpad',
      name: `${possessive(pad.name)} launch contract`,
      tradable: false,
      launchpad: pad.name,
      evidence: `emits ${pad.event.split('(')[0]} for each launch`,
    };
  }
  return null;
}

/** Reads a TokenTable lock of `token`: its schedules, what is still locked, who manages it. */
async function readLock(
  rpc: RpcClient,
  address: string,
  version: string,
  context: RoleContext,
): Promise<VestingLock | null> {
  const ids = Array.from({ length: MAX_SCHEDULES }, (_, i) => i);
  const first = await batched(rpc, [
    call(address, SELECTOR.getProjectToken),
    call(address, SELECTOR.futureToken),
    call(address, SELECTOR.owner),
    call(address, SELECTOR.isCancelable),
    call(address, SELECTOR.isWithdrawable),
    ...ids.map((i) => call(address, `${SELECTOR.actuals}${uint(i)}`)),
  ]);
  const value = (i: number) => valueAt(first, i);
  if (asAddress(value(0)) !== lower(context.token)) return null;
  const futureToken = asAddress(value(1));
  // `actuals(i)`: (presetId, startTimestampAbsolute, amountClaimed, totalAmount).
  const actuals = ids
    .map((i) => ({ id: i, w: words(value(5 + i)) }))
    .filter((a): a is { id: number; w: bigint[] } =>
      Boolean(a.w && a.w.length >= 4 && a.w[3]! > 0n),
    );
  if (actuals.length === 0) return null;
  const second = await batched(
    rpc,
    actuals.flatMap((a) => [
      call(address, `${SELECTOR.calculateAmountClaimable}${uint(a.id)}`),
      call(address, `${SELECTOR.getEncodedPreset}${a.w[0]!.toString(16).padStart(64, '0')}`),
      ...(futureToken ? [call(futureToken, `${SELECTOR.ownerOf}${uint(a.id)}`)] : []),
    ]),
  );
  const per = futureToken ? 3 : 2;
  const schedules: VestingSchedule[] = [];
  const now = (context.now ?? (() => new Date()))().getTime() / 1000;
  let locked = 0n;
  const stepsAt: number[] = [];
  actuals.forEach((a, k) => {
    const at = (j: number) => valueAt(second, k * per + j);
    const claimable = words(at(0))?.[0];
    const preset = decodePreset(at(1));
    if (claimable === undefined || !preset) return;
    const start = Number(a.w[1]);
    const claimed = a.w[2]!;
    const total = a.w[3]!;
    locked += total > claimed + claimable ? total - claimed - claimable : 0n;
    for (const step of unlockSteps(preset)) stepsAt.push(start + step.at);
    schedules.push(
      scheduleOf({
        beneficiary: futureToken ? asAddress(at(2)) : null,
        start,
        total,
        claimed,
        claimable,
        preset,
        supply: context.supply,
      }),
    );
  });
  if (schedules.length === 0) return null;
  const upcoming = stepsAt.filter((t) => t > now).sort((x, y) => x - y);
  return {
    provider: 'TokenTable',
    version,
    owner: asAddress(value(2)),
    cancelable: asBool(value(3)),
    withdrawable: asBool(value(4)),
    schedules: schedules.sort((x, y) => x.startsAt.localeCompare(y.startsAt)),
    locked: share6(locked, context.supply),
    nextUnlockAt: upcoming[0] !== undefined ? iso(upcoming[0]) : null,
    fullyUnlockedAt: stepsAt.length > 0 ? iso(Math.max(...stepsAt)) : null,
  };
}

/** "the Virtuals reserve wallet" when the lock's manager is a known address. */
function managerWords(owner: string | null): string {
  if (!owner) return 'its manager';
  return owner === VIRTUALS.reserveWallet ? 'Virtuals’ reserve wallet' : owner;
}

/** The names known without a read, for when the reads could not be made. */
export function knownNames(
  candidates: readonly { address: string }[],
  context: Pick<RoleContext, 'curves' | 'launchpad'>,
): NamedAddress[] {
  return candidates
    .map((c) => knownName(c.address, context))
    .filter((n): n is NamedAddress => n !== null);
}

/**
 * Names each candidate by what it is. Addresses read and found to be nothing
 * in particular are left out: the report keeps calling them a wallet or a
 * contract. A read that fails leaves the address unnamed, never misnamed.
 */
export async function readAddressRoles(
  rpc: RpcClient,
  candidates: readonly Candidate[],
  context: RoleContext,
): Promise<NamedAddress[]> {
  const token = lower(context.token);
  const named = new Map<string, NamedAddress>();
  const unique = [...new Map(candidates.map((c) => [lower(c.address), c])).values()].filter(
    (c) => lower(c.address) !== token && !/^0x0{40}$/.test(lower(c.address)),
  );
  for (const c of unique) {
    const known = knownName(c.address, context);
    if (known) named.set(known.address, known);
  }
  const rest = unique.filter((c) => !named.has(lower(c.address)));
  // Codes not known yet are read first: a wallet answers none of the probes.
  const unknownCode = rest.filter((c) => c.isContract === null);
  const codes = await batched(
    rpc,
    unknownCode.map((c) => ({ method: 'eth_getCode', params: [lower(c.address), 'latest'] })),
  );
  const contracts = rest
    .filter((c) => {
      if (c.isContract !== null) return c.isContract;
      const i = unknownCode.indexOf(c);
      return isContractCode(valueAt(codes, i));
    })
    .slice(0, MAX_PROBED)
    .map((c) => lower(c.address));
  if (contracts.length === 0) return [...named.values()];

  const probes = ['version', 'token0', 'entryPoint'] as const;
  const answers = await batched(
    rpc,
    contracts.flatMap((a) => probes.map((p) => call(a, SELECTOR[p]))),
  );
  const answer = (i: number, p: (typeof probes)[number]) => {
    return valueAt(answers, i * probes.length + probes.indexOf(p));
  };

  const pools: { address: string; token0: string }[] = [];
  for (const [i, address] of contracts.entries()) {
    const version = asString(answer(i, 'version'));
    if (version && /TTUnlocker/i.test(version)) {
      const lock = await readLock(rpc, address, version, context).catch(() => null);
      if (lock) {
        const virtuals = lock.owner === VIRTUALS.reserveWallet;
        named.set(address, {
          address,
          kind: 'vesting',
          name: virtuals ? 'Virtuals’ team lock (TokenTable)' : 'a vesting lock (TokenTable)',
          detail: `Its tokens unlock on a schedule; ${managerWords(lock.owner)} manages it${
            lock.cancelable || lock.withdrawable
              ? ` and can still ${[lock.cancelable ? 'cancel schedules' : '', lock.withdrawable ? 'withdraw the deposit' : ''].filter(Boolean).join(' and ')}`
              : ''
          }.`,
          tradable: false,
          ...(virtuals ? { launchpad: 'Virtuals' } : {}),
          lock,
          evidence: `version() = "${version}", getProjectToken() = this token`,
        });
      }
      continue;
    }
    const t0 = asAddress(answer(i, 'token0'));
    if (t0) {
      pools.push({ address, token0: t0 });
      continue;
    }
    const entry = asAddress(answer(i, 'entryPoint'));
    if (entry && ENTRY_POINTS.includes(entry)) {
      named.set(address, {
        address,
        kind: 'smart-wallet',
        name: 'a smart-contract wallet',
        detail: 'An ERC-4337 account: a wallet run by a contract, for a person or a service.',
        tradable: true,
        evidence: `entryPoint() = ${entry}`,
      });
    }
  }

  if (pools.length > 0) {
    const kinds = await batched(
      rpc,
      pools.flatMap((p) => [
        call(p.address, SELECTOR.token1),
        call(p.address, SELECTOR.fee),
        call(p.address, SELECTOR.getReserves),
      ]),
    );
    const found = pools
      .map((p, k) => {
        const t1 = asAddress(valueAt(kinds, k * 3));
        const fee = words(valueAt(kinds, k * 3 + 1))?.[0];
        const reserves = words(valueAt(kinds, k * 3 + 2));
        const version = fee !== undefined ? 'V3' : reserves && reserves.length >= 2 ? 'V2' : null;
        if (!t1 || !version || (p.token0 !== token && t1 !== token)) return null;
        return { address: p.address, other: p.token0 === token ? t1 : p.token0, version };
      })
      .filter((p): p is { address: string; other: string; version: 'V2' | 'V3' } => p !== null);
    const symbols = await batched(
      rpc,
      found.map((p) => call(p.other, SELECTOR.symbol)),
    ).catch(() => []);
    found.forEach((p, k) => {
      const symbol = asString(valueAt(symbols, k));
      const version = p.version;
      const against = symbol ? ` against ${symbol}` : '';
      named.set(p.address, {
        address: p.address,
        kind: 'pool',
        name: `a ${version} trading pool${against}`,
        detail: `A Uniswap ${version}-style pool trading this token${against}: what it holds is liquidity, not anyone’s position.`,
        tradable: false,
        evidence: `token0()/token1() name this token${version === 'V3' ? ', fee() answers' : ', getReserves() answers'}`,
      });
    });
  }
  return [...named.values()];
}
