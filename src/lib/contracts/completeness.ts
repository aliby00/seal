/**
 * Chaque bloc de données porte son propre niveau de complétude.
 *
 * Le whitepaper assume publiquement que la vue peut être partielle — « a creator's
 * full history depends on indexing ». Pour que l'agent puisse le *dire*, il faut
 * qu'il le *sache* : c'est le rôle de ce type, et la raison pour laquelle il
 * accompagne chaque source plutôt que d'être un drapeau global.
 */
export type Completeness =
  /** Toutes les données attendues ont été récupérées. */
  | 'full'
  /** Une partie seulement : fenêtre tronquée, pagination interrompue, rate limit. */
  | 'partial'
  /** Rien n'a pu être récupéré. L'analyse continue sans cette source. */
  | 'unavailable';

/** D'où vient une donnée, et quand. Permet à l'agent de citer ses sources. */
export type SourceRef = {
  name: 'robinhood-rpc' | 'blockscout' | 'dexscreener';
  fetchedAt: string;
  /** Renseigné quand la source a échoué ou n'a répondu que partiellement. */
  note?: string;
};

/** Enveloppe commune à tout bloc de données produit par le pipeline. */
export type Sourced<T> = {
  completeness: Completeness;
  sources: SourceRef[];
  data: T;
};

/** La complétude d'un ensemble est celle de son maillon le plus faible. */
export function combineCompleteness(values: readonly Completeness[]): Completeness {
  if (values.length === 0) return 'unavailable';
  if (values.includes('unavailable')) return 'partial';
  if (values.includes('partial')) return 'partial';
  return 'full';
}

/** Vrai si aucune source n'a rien donné — l'analyse n'a alors rien à raisonner. */
export function isEmpty(values: readonly Completeness[]): boolean {
  return values.length > 0 && values.every((value) => value === 'unavailable');
}
