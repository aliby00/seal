import type { Usage } from '../cost';

/**
 * Interface commune aux fournisseurs de raisonnement.
 *
 * SEAL ne dépend pas d'un modèle en particulier : le produit, c'est le
 * croisement des signaux et la façon de l'exprimer. Le fournisseur se choisit
 * par variable d'environnement, ce qui permet de développer gratuitement et
 * de basculer sur un modèle plus capable quand la qualité le justifie.
 */
export type ProviderName = 'anthropic' | 'groq';

export type CompletionRequest = {
  system: string;
  user: string;
  maxTokens: number;
  model: string;
};

export type CompletionResult = {
  text: string;
  usage: Usage;
  /** Renseigné si le modèle a interrompu sa réponse pour une raison notable. */
  stopReason?: string;
};

export type Provider = {
  name: ProviderName;
  complete(request: CompletionRequest): Promise<CompletionResult>;
};
