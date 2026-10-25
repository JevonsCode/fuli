import { z } from 'zod';

import { parse } from './service.js';

// The console's list of Tonborg's knowledge review suggestions (rec#8): the
// verdicts the host did not apply and left to the person (ai_suggested,
// rec#10 D-24, D-36), shown under 「建议记录」 beside what Astro, Bole and
// Jefa suggested. Like that log (rec#10 D-30) each one is what Tonborg said
// at the time, never a to-do: whether the item still waits is answered by
// the knowledge item the action opens, which the console reads as the person
// (src/knowledge-owner-reads). A verdict holds only what Tonborg read as a
// plain session, so it names no FLA's own knowledge; Agents get the same
// verdicts in review_with_tonborg's reply and in list_judgments. Only the
// console's GET route uses this module; no MCP or Agent tool module imports
// it (test/tonborg-review-suggestions.test.js).

// The newest suggestions the section can show; older ones stay on Tonborg's page.
const SUGGESTION_LIMIT = 50;
const id = z.string().trim().min(1).max(256);
const listInput = z.object({ personalSpaceId: id }).strict();

// A suggestion followed by a newer one for the same item in the same project
// reads stale: 'newer' (as the role suggestion log, D-30.3).
export async function tonborgReviewSuggestions({ judgment, input }) {
  const { personalSpaceId } = parse(listInput, input);
  await judgment.scope({ personalSpaceId });
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
