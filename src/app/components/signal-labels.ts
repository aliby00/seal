import type { Signal } from '@/lib/specialists/types';

/**
 * How a specialist's answer is labelled. Always shown with an icon as well:
 * colour is never the only carrier. The words describe the kind of fact, not
 * the token — none of them is a verdict, and nothing anywhere adds them up.
 */
export const SIGNAL_LABEL: Record<Signal, string> = {
  concern: 'Worth attention',
  reassurance: 'Rules a mechanism out',
  observation: 'Notable',
  quiet: 'Nothing notable',
  unknown: 'Not measured',
};
