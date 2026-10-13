import { CATALOG } from './catalog';
import type { Checklist } from './compose';
import type { Finding, SpecialistContext, SpecialistId } from './types';

/** Au plus trois pistes suivies hors de la sélection : l'enquête reste bornée et lisible. */
export const MAX_LEADS = 3;

export type RunResult = {
  findings: Finding[];
  /** Spécialistes ajoutés par l'enquête, hors de la sélection de l'agent. Restitués comme tels. */
  leads: SpecialistId[];
};

/**
 * Exécute un agent composé.
 *
 * L'enquête autonome tient en une règle : un constat peut désigner d'autres
 * spécialistes (`followUps`). Si l'agent l'autorise, on les lance — une seule
 * vague, au plus `MAX_LEADS`. Pas de boucle de modèle qui décide où chercher :
 * les pistes sont écrites dans le code et se relisent.
 */
export function runAgent(checklist: Checklist, context: SpecialistContext): RunResult {
  const findings = checklist.specialists.map((id) => CATALOG[id].run(context));
  if (!checklist.followLeads) return { findings, leads: [] };

  const done = new Set<SpecialistId>(checklist.specialists);
  const leads: SpecialistId[] = [];
  for (const f of findings) {
    if (f.signal !== 'concern' && f.signal !== 'observation') continue;
    for (const next of f.followUps ?? []) {
      if (done.has(next) || leads.length >= MAX_LEADS) continue;
      done.add(next);
      leads.push(next);
    }
  }
  return { findings: [...findings, ...leads.map((id) => CATALOG[id].run(context))], leads };
}

export type Divergence = { notable: number; conflicts: number; concerns: number };

/**
 * Mesure du désaccord entre spécialistes. Un conflit, c'est un constat
 * d'attention face à un constat rassurant : c'est là que la restitution doit
 * réfléchir, et donc là que le routage paie un modèle plus capable.
 */
export function measureDivergence(findings: readonly Finding[]): Divergence {
  const concerns = findings.filter((f) => f.signal === 'concern').length;
  const reassurances = findings.filter((f) => f.signal === 'reassurance').length;
  const observations = findings.filter((f) => f.signal === 'observation').length;
  return {
    concerns,
    notable: concerns + reassurances + observations,
    conflicts: Math.min(concerns, reassurances),
  };
}

/** L'agent signale-t-il ce marché ? C'est ce que le classement compare à ce qui s'est passé ensuite. */
export function isFlagged(checklist: Checklist, findings: readonly Finding[]): boolean {
  // Seuls les spécialistes choisis comptent : une piste suivie informe, elle ne vote pas.
  const chosen = new Set(checklist.specialists);
  const concerns = findings.filter(
    (f) => chosen.has(f.specialist) && f.signal === 'concern',
  ).length;
  return concerns >= checklist.flagThreshold;
}
