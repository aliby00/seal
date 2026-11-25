import type { SolanaView } from './solana-view';

/**
 * How the Solana creator was found, said plainly, with what it does not
 * prove. Shared by the creator card and the Solana creator card.
 */
export function creatorFrom(from: SolanaView['creator']['data']['from']): string | null {
  switch (from) {
    case 'pump-curve':
      return 'Named as creator by the token’s pump.fun bonding curve.';
    case 'creation-transaction':
      return 'Paid for the transaction that created the mint. A launch service can pay it: this does not prove who made the token.';
    case 'metadata-update-authority':
      return 'Can edit the token’s name and symbol. Often a team or a service: this does not prove who made the token.';
    default:
      return null;
  }
}
