import { decodeFunctionResult, encodeFunctionData, parseAbiItem, type Address } from 'viem';
import { UpstreamError } from '../errors';
import type { RpcClient } from './rpc';

/** Encode l'appel `graduationStatus(token)`, réutilisable en batch. */
export function encodeGraduationCall(token: Address): string {
  return encodeFunctionData({
    abi: [GRADUATION_STATUS],
    functionName: 'graduationStatus',
    args: [token],
  });
}

/** Décode une réponse brute d'eth_call. `null` si vide ou revert. */
export function decodeGraduationResult(raw: string | undefined): GraduationStatus | null {
  if (!raw || raw === '0x') return null;
  try {
    const [pairedPrincipal, threshold, graduated] = decodeFunctionResult({
      abi: [GRADUATION_STATUS],
      functionName: 'graduationStatus',
      data: raw as `0x${string}`,
    }) as unknown as [bigint, bigint, boolean];
    return toGraduationStatus(pairedPrincipal, threshold, graduated);
  } catch {
    // Une réponse inattendue vaut « inconnu », pas une panne de l'analyse.
    return null;
  }
}

/**
 * Lit l'état de graduation de plusieurs tokens en une seule requête HTTP.
 *
 * C'est ce qui rend un historique profond praticable : sans batch, 40 tokens
 * coûtent 40 allers-retours sur un RPC public qui répond 403 après une rafale.
 * Un token dont l'appel revert donne `null` sans faire échouer les autres.
 */
export async function fetchGraduationStatusBatch(
  rpc: RpcClient,
  factory: Address,
  tokens: readonly Address[],
): Promise<(GraduationStatus | null)[]> {
  if (tokens.length === 0) return [];
  const outcomes = await rpc.callBatch<string>(
    tokens.map((token) => ({
      method: 'eth_call',
      params: [{ to: factory, data: encodeGraduationCall(token) }, 'latest'],
    })),
  );
  return outcomes.map((outcome) => (outcome.ok ? decodeGraduationResult(outcome.value) : null));
}

/** Horodatages de blocs, groupés. Sert à remplir `launchedAt`. */
export async function fetchBlockTimestamps(
  rpc: RpcClient,
  blockNumbers: readonly number[],
): Promise<(string | null)[]> {
  if (blockNumbers.length === 0) return [];
  const outcomes = await rpc.callBatch<{ timestamp?: string } | null>(
    blockNumbers.map((n) => ({
      method: 'eth_getBlockByNumber',
      params: [`0x${n.toString(16)}`, false],
    })),
  );
  return outcomes.map((outcome) => {
    if (!outcome.ok || !outcome.value?.timestamp) return null;
    return new Date(Number(outcome.value.timestamp) * 1000).toISOString();
  });
}

/**
 * `graduationStatus(address)` — vérifié en direct sur le factory vivant.
 * Selector `0x98d652f1`. Le seuil renvoyé valait 4,2 ETH lors de la mesure,
 * mais il est lu et non codé en dur : c'est un paramètre du contrat.
 */
export const GRADUATION_STATUS = parseAbiItem(
  'function graduationStatus(address token) view returns (uint256 pairedPrincipal, uint256 threshold, bool graduated)',
);

export type GraduationStatus = {
  pairedPrincipalWei: bigint;
  thresholdWei: bigint;
  graduated: boolean;
  pairedEth: number;
  thresholdEth: number;
  progress: number;
};

const WEI_PER_ETH = 1e18;

export function toGraduationStatus(
  pairedPrincipal: bigint,
  threshold: bigint,
  graduated: boolean,
): GraduationStatus {
  const pairedEth = Number(pairedPrincipal) / WEI_PER_ETH;
  const thresholdEth = Number(threshold) / WEI_PER_ETH;
  return {
    pairedPrincipalWei: pairedPrincipal,
    thresholdWei: threshold,
    graduated,
    pairedEth,
    thresholdEth,
    progress: thresholdEth > 0 ? Math.min(1, pairedEth / thresholdEth) : 0,
  };
}

/**
 * Lit l'état de graduation d'un token auprès d'un factory donné.
 *
 * Renvoie `null` si l'appel revert : c'est le signe que ce token n'appartient
 * pas à ce factory-là. La documentation pons annonce un factory sur lequel tous
 * les tokens récents revert — d'où la nécessité de traiter ce cas comme une
 * information, pas comme une panne.
 */
export async function fetchGraduationStatus(
  rpc: RpcClient,
  factory: Address,
  token: Address,
): Promise<GraduationStatus | null> {
  const data = encodeFunctionData({
    abi: [GRADUATION_STATUS],
    functionName: 'graduationStatus',
    args: [token],
  });

  let raw: string;
  try {
    raw = await rpc.call<string>('eth_call', [{ to: factory, data }, 'latest']);
  } catch (error) {
    if (error instanceof UpstreamError && /revert/i.test(error.message)) return null;
    throw error;
  }

  if (!raw || raw === '0x') return null;

  const [pairedPrincipal, threshold, graduated] = decodeFunctionResult({
    abi: [GRADUATION_STATUS],
    functionName: 'graduationStatus',
    data: raw as `0x${string}`,
  }) as unknown as [bigint, bigint, boolean];

  return toGraduationStatus(pairedPrincipal, threshold, graduated);
}
