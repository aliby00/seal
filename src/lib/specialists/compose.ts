import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SPECIALIST_IDS, type SpecialistId } from './types';

/**
 * Composer son agent.
 *
 * Un agent, c'est une sélection de spécialistes et des préférences. Aucun
 * champ ne prend de texte libre destiné au modèle : il n'y a donc rien à
 * injecter. Le nom de l'agent est affiché, jamais envoyé au modèle, et son
 * alphabet est restreint quand même.
 */

const specialistId = z.enum(SPECIALIST_IDS);

export const AgentSpecSchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{1,31}$/, 'letters, digits, space, - and _ only (2–32)'),
    specialists: z
      .array(specialistId)
      .min(1)
      .max(SPECIALIST_IDS.length)
      .refine((ids) => new Set(ids).size === ids.length, 'each specialist at most once'),
    preferences: z
      .object({
        /** Jusqu'à trois spécialistes mis en avant dans la restitution. */
        emphasis: z.array(specialistId).max(3).default([]),
        detail: z.enum(['brief', 'full']).default('full'),
        language: z.enum(['en', 'fr']).default('en'),
        /**
         * Quand l'agent signale un marché : dès un constat d'attention, ou à
         * partir de deux. C'est ce qui sépare un agent prudent d'un agent
         * discret, et c'est mesurable au classement.
         */
        flagOn: z.enum(['one-concern', 'two-concerns']).default('one-concern'),
        /** L'agent peut-il suivre une piste au-delà de ses spécialistes ? */
        followLeads: z.boolean().default(true),
      })
      .strict()
      .default({
        emphasis: [],
        detail: 'full',
        language: 'en',
        flagOn: 'one-concern',
        followLeads: true,
      }),
  })
  .strict()
  .superRefine((spec, ctx) => {
    for (const id of spec.preferences.emphasis) {
      if (!spec.specialists.includes(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['preferences', 'emphasis'],
          message: `"${id}" is emphasised but not part of the agent`,
        });
      }
    }
  });

export type AgentSpec = z.input<typeof AgentSpecSchema>;

/** Ce qui s'exécute réellement. Le texte d'origine n'existe plus à ce stade. */
export type Checklist = {
  name: string;
  /** Ordre d'exécution et de restitution : les spécialistes mis en avant d'abord. */
  specialists: SpecialistId[];
  emphasis: SpecialistId[];
  detail: 'brief' | 'full';
  language: 'en' | 'fr';
  flagThreshold: 1 | 2;
  followLeads: boolean;
  /**
   * Empreinte de la configuration, nom exclu. Deux agents à empreinte égale
   * se comportent pareil : le classement peut le dire au lieu de compter deux
   * fois le même agent.
   */
  fingerprint: string;
};

export class InvalidAgentSpecError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid agent: ${issues.join('; ')}`);
    this.name = 'InvalidAgentSpecError';
  }
}

export function compileAgent(input: unknown): Checklist {
  const parsed = AgentSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidAgentSpecError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const { name, specialists, preferences: p } = parsed.data;
  const ordered = [...p.emphasis, ...specialists.filter((id) => !p.emphasis.includes(id))];
  const flagThreshold = p.flagOn === 'two-concerns' ? 2 : 1;

  // L'ordre de sélection ne change pas le comportement ; l'emphase, si.
  const behaviour = {
    specialists: [...specialists].sort(),
    emphasis: p.emphasis,
    detail: p.detail,
    language: p.language,
    flagThreshold,
    followLeads: p.followLeads,
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(behaviour))
    .digest('hex')
    .slice(0, 16);

  return {
    name,
    specialists: ordered,
    emphasis: p.emphasis,
    detail: p.detail,
    language: p.language,
    flagThreshold,
    followLeads: p.followLeads,
    fingerprint,
  };
}
