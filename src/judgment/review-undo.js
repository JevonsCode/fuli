import { z } from 'zod';

import { EmployeeError } from '../employees/manifest.js';
import { personalHumanReviewChannel, providerRefusal } from '../graphiti/human-review-channel.js';
import { parse } from './service.js';

// The person's one-click undo of a knowledge review Tonborg applied by itself
// (rec#10 D-24, D-36.12). The Provider removes the item's AI review marks only on the
// human-review channel (human-review-channel.js), so an Agent's token alone is
// refused. Only the console's loopback route uses this module; no MCP or Agent
// tool module imports it (test/tonborg-model-trust.test.js).
//
// An undo takes back that one review and nothing after it: an item the person
// changed since, or one a later review replaced, is refused as
// ai_review_changed (已被修改); a permanently deleted item as
// ai_review_deleted (已删除), which nothing brings back. A refused undo
// changes nothing and records nothing.

const id = z.string().trim().min(1).max(256);
const undoInput = z.object({ personalSpaceId: id, decisionId: id }).strict();

export function reviewUndoConsole(dataDir, { send = personalHumanReviewChannel(dataDir) } = {}) {
  return {
    async withdrawAiReview(body) {
      const { ok, status, payload } = await send('/v1/knowledge/reviews/ai-review/withdraw', body, { review: true });
      if (ok) return payload;
      throw providerRefusal(status, payload);
    }
  };
}

// Any applied review can be undone, including one an earlier FULI applied
// before the gate existed. The judgment and its receipts stay; the undo is
// one more receipt.
export async function undoAutomaticReview({ judgment, undoConsole, input }) {
  const { personalSpaceId, decisionId } = parse(undoInput, input);
  await judgment.scope({ personalSpaceId });
  const store = judgment.store();
  const record = store.get(personalSpaceId, decisionId);
  const intent = record.executionHistory.findLast(entry => entry.status === 'applying')?.receipt;
  if (record.kind !== 'review' || record.execution.status !== 'applied' || !intent?.candidateKey) {
    throw new EmployeeError('Only a review Tonborg applied can be undone.', 409, 'judgment_not_undoable');
  }
  if (record.hard_deleted || store.forgets(intent.candidateKey, personalSpaceId)) {
    throw new EmployeeError('Cannot undo: the item was permanently deleted.', 409, 'ai_review_deleted');
  }
  const withdrawn = await undoConsole.withdrawAiReview({ personal_space_id: personalSpaceId, review_id: intent.reviewId,
    candidate_key: intent.candidateKey, ai_review_evidence_token: intent.aiReviewEvidenceToken });
  return store.execute(personalSpaceId, record.id, 'undone', { by: 'person', reviewId: intent.reviewId,
    candidateKey: intent.candidateKey, decisionId: withdrawn.decision_id });
}
