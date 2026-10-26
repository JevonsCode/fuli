import { z } from 'zod';

// Public decisions never carry host reservation or reconciliation arguments.
const decision = z.object({ draftId: z.string().min(1),
  decision: z.enum(['submit_public', 'keep_personal', 'ignore']) });

export function parsePersonalDraftDecision(input) {
  const parsed = decision.safeParse(input);
  if (!parsed.success) throw new TypeError('Unknown personal draft decision or invalid draft ID');
  return parsed.data;
}
