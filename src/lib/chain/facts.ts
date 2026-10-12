import { decodeFunctionResult, parseAbiItem } from 'viem';
import type { RpcClient } from './rpc';

/**
 * Petites lectures on-chain dont les spécialistes ont besoin, groupées en un
 * seul batch JSON-RPC. Chacune peut échouer seule : un `null` veut dire « pas
 * lu », jamais « vide ».
 */

const NAME = parseAbiItem('function name() view returns (string)');
const SYMBOL = parseAbiItem('function symbol() view returns (string)');

/**
 * Emplacements EIP-1967. Un hook derrière un proxy peut changer de code sans
 * changer d'adresse — donc sans changer de permissions apparentes. C'est le
 * seul moyen pour un rulebook de « changer les règles » après coup.
 */
export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const EIP1967_ADMIN_SLOT =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1135d1e87ef6f8df1aa6';
/** Beacon EIP-1967 : une famille de tokens qui partagent une même implémentation. */
export const EIP1967_BEACON_SLOT =
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

export type TokenMeta = { name: string | null; symbol: string | null };

export type HookCode = {
  /** Taille du bytecode en octets. 0 = rien de déployé à cette adresse. */
  codeSize: number | null;
  /** Implémentation EIP-1967 si le hook est un proxy, sinon `null`. */
  implementation: string | null;
  admin: string | null;
};

function decodeString(abi: typeof NAME | typeof SYMBOL, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '0x') return null;
  try {
    return decodeFunctionResult({ abi: [abi], data: raw as `0x${string}` }) as string;
  } catch {
    return null;
  }
}

function slotAddress(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw)) return null;
  const value = BigInt(raw);
  if (value === 0n) return null;
  return `0x${value.toString(16).padStart(40, '0').slice(-40)}`;
}

export async function readTokenMetas(
  rpc: RpcClient,
  tokens: readonly string[],
): Promise<Map<string, TokenMeta>> {
  const result = new Map<string, TokenMeta>();
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))];
  // name() = 0x06fdde03, symbol() = 0x95d89b41.
  for (let i = 0; i < unique.length; i += 10) {
    const chunk = unique.slice(i, i + 10);
    const outcomes = await rpc.callBatch<string>(
      chunk.flatMap((to) => [
        { method: 'eth_call', params: [{ to, data: '0x06fdde03' }, 'latest'] },
        { method: 'eth_call', params: [{ to, data: '0x95d89b41' }, 'latest'] },
      ]),
    );
    chunk.forEach((token, j) => {
      const name = outcomes[j * 2];
      const symbol = outcomes[j * 2 + 1];
      result.set(token, {
        name: name?.ok ? decodeString(NAME, name.value) : null,
        symbol: symbol?.ok ? decodeString(SYMBOL, symbol.value) : null,
      });
    });
  }
  return result;
}

export type OnchainFacts = {
  hookCode: HookCode | null;
  /** Nombre de transactions envoyées par le créateur. `null` si non lu. */
  creatorNonce: number | null;
  /** Beacon EIP-1967 du token, s'il en est un proxy. */
  tokenBeacon: string | null;
};

export async function readOnchainFacts(
  rpc: RpcClient,
  input: { hook: string | null; creator: string | null; token?: string | null },
): Promise<OnchainFacts> {
  const requests = [
    ...(input.hook
      ? [
          { method: 'eth_getCode', params: [input.hook, 'latest'] },
          {
            method: 'eth_getStorageAt',
            params: [input.hook, EIP1967_IMPLEMENTATION_SLOT, 'latest'],
          },
          { method: 'eth_getStorageAt', params: [input.hook, EIP1967_ADMIN_SLOT, 'latest'] },
        ]
      : []),
    ...(input.creator
      ? [{ method: 'eth_getTransactionCount', params: [input.creator, 'latest'] }]
      : []),
    ...(input.token
      ? [{ method: 'eth_getStorageAt', params: [input.token, EIP1967_BEACON_SLOT, 'latest'] }]
      : []),
  ];
  if (requests.length === 0) return { hookCode: null, creatorNonce: null, tokenBeacon: null };

  const out = await rpc.callBatch<string>(requests);
  let i = 0;
  let hookCode: HookCode | null = null;
  if (input.hook) {
    const [code, impl, admin] = [out[i++], out[i++], out[i++]];
    hookCode = {
      codeSize: code?.ok ? Math.max(0, (code.value.length - 2) / 2) : null,
      implementation: impl?.ok ? slotAddress(impl.value) : null,
      admin: admin?.ok ? slotAddress(admin.value) : null,
    };
  }
  const nonce = input.creator ? out[i++] : undefined;
  const beacon = input.token ? out[i] : undefined;
  return {
    hookCode,
    creatorNonce: nonce?.ok ? Number(nonce.value) : null,
    tokenBeacon: beacon?.ok ? slotAddress(beacon.value) : null,
  };
}
