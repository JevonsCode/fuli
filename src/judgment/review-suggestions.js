import { z } from 'zod';

import { ApplicationError } from '../app/application-error.js';
import { ProviderRequestError } from '../graphiti/provider-client.js';
import { parse } from './service.js';

// The console's list of Tonborg's knowledge review suggestions (rec#8): the
// verdicts the host did not apply and left to the person (ai_suggested,
// rec#10 D-24, D-36), shown under 「建议记录」 beside what Astro, Bole and
// Jefa suggested. Like that log (rec#10 D-30) each one is what Tonborg said
// at the time, never a to-do: whether the item still waits is answered by
// the knowledge item the action opens.
//
// A verdict keeps the item's title and key from when Tonborg read it, and its
// summary is the model's free text, written with Tonborg's scoped
// preferences, memory and earlier feedback in the same request. The item may
// have become one FLA's own since, and the summary may quote any of that. So
// this list is the person's owner read and nothing less: it answers only
// after ownerReads, the console's human-review port (src/knowledge-owner-reads),
// has confirmed the console's proof with the Provider. Without the port or its
// proof it is refused with no data (403); a proof the Provider refuses is
// refused as the Provider answered. There is no filtered view for anyone else.
// Only the console's loopback GET route uses this module; no MCP or Agent tool
// module imports it (test/tonborg-review-suggestions.test.js). Agents get
// Tonborg's verdicts from review_with_tonborg and list_judgments as before.

// The newest suggestions the section can show; older ones stay on Tonborg's page.
const SUGGESTION_LIMIT = 50;
const id = z.string().trim().min(1).max(256);
const listInput = z.object({ personalSpaceId: id }).strict();
const proofRequired = () => new ApplicationError('human_review_proof_required',
  'Tonborg\'s suggestions are read only by the local console with its human-review proof', { status: 403 });

// A suggestion followed by a newer one for the same item in the same project
// reads stale: 'newer' (as the role suggestion log, D-30.3).
export async function tonborgReviewSuggestions({ judgment, ownerReads, input }) {
  const { personalSpaceId } = parse(listInput, input);
  await judgment.scope({ personalSpaceId });
  await confirmOwner(ownerReads, personalSpaceId);
  const seen = new Set();
  return judgment.store().reviewSuggestions(personalSpaceId, SUGGESTION_LIMIT).map(record => {
    const subject = `${record.personalProjectId ?? ''}\u0000${record.target}`;
    const newer = seen.has(subject);
    seen.add(subject);
    return { id: record.id, createdAt: record.createdAt, personalSpaceId, personalProjectId: record.personalProjectId ?? null,
      target: record.target, title: record.title ?? null, summary: record.summary, confidence: record.confidence ?? null,
      aiReview: record.aiReview, model: record.model ?? null, client: record.client ?? null,
      judgedBy: record.judgedBy ?? null, ...(record.hard_deleted ? { hard_deleted: true } : {}),
      ...(newer ? { stale: 'newer' } : {}) };
  });
}

// The Provider's answer decides: its refusal of the proof (401, 403) and its
// own failures pass on as they are. A port that could not send a proof at all
// (no local installation, no human-review token) is no proof.
async function confirmOwner(ownerReads, personalSpaceId) {
  if (!ownerReads) throw proofRequired();
  try {
    await ownerReads.confirmOwner(personalSpaceId);
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    throw proofRequired();
  }
}
