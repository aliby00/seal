import type { SolanaView } from './solana-view';

/**
 * How the Solana creator was found, said plainly, with what it does not
 * prove. Shared by the creator card and the Solana creator card.
 */
export function creatorFrom(
  from: SolanaView['creator']['data']['from'],
  /**
   * The powers the mint gives today: an update authority since revoked is
   * said in the past, or the card contradicts the mint panel (POPCAT, 26/11/2026).
   */
  powers?: SolanaView['powers'],
): string | null {
  switch (from) {
    case 'pump-curve':
      return 'Named as creator by the token’s pump.fun bonding curve.';
    case 'creation-transaction':
      return 'Paid for the transaction that created the mint. A launch service can pay it: this does not prove who made the token.';
    case 'metadata-update-authority':
      if (powers?.some((p) => p.power === 'metadata-update' && p.status === 'none'))
        return 'Was the metadata update authority (now revoked). This does not prove who made the token.';
      return 'Can edit the token’s name and symbol. Often a team or a service: this does not prove who made the token.';
    case 'launchpad-account':
      return 'Named as creator by the token’s launchpad pool (Meteora DBC or Raydium LaunchLab).';
    case 'mint-key-signer':
      return 'Paid for the mint’s first transaction, which the mint’s own key signed.';
    default:
      return null;
  }
}
