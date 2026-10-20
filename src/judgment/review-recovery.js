import { EmployeeError } from '../employees/manifest.js';

// rec#8 C11: a Tonborg review persists its write intent (review run and
// candidate, the Provider's stable key for the decision) before it sends the
// Provider write. A rerun of the same request settles every intent an
// interrupted run left behind against the Provider's own decision, instead of
// rebuilding from the candidates the Provider still offers (a recorded one is
// no longer offered): applied when the Provider holds this write, not applied
// when it never arrived (the item is reviewed again), stale when the Provider
// holds a different decision. When the Provider cannot answer, the result is
// unknown and the rerun stops for a retry; it is never reported as done.
export async function recoverInterruptedWrites({ app, store, space, requestKey, lease }) {
  const records = [];
  for (const record of store.requestRecords(space, requestKey).filter(item => item.evidenceFingerprint)) {
    records.push(record.execution.status === 'applying' ? await settle({ app, store, space, record, lease }) : record);
  }
  return records;
}

async function settle({ app, store, space, record, lease }) {
  const intent = record.execution.receipt;
  let decision;
  try {
    ({ decision } = await app.readKnowledgeReviewDecision({ personalSpaceId: space, reviewId: intent.reviewId, candidateKey: intent.candidateKey }));
  } catch (error) {
    throw Object.assign(new EmployeeError('Tonborg cannot confirm an interrupted review write yet. Try again.', 503, 'judgment_result_unknown'),
      { retryable: true, cause: error });
  }
  if (!decision) return store.execute(space, record.id, 'not_applied', { reason: 'The interrupted write never reached the Provider.' }, lease);
  if (decision.outcome === 'ai_reviewed' && decision.ai_review_evidence_token === intent.aiReviewEvidenceToken) {
    return store.execute(space, record.id, 'applied',
      { reviewId: intent.reviewId, outcome: decision.outcome, decisionId: decision.decision_id, recovered: true }, lease);
  }
  return store.execute(space, record.id, 'stale', { reason: 'The Provider holds a different decision for this item. Review again.' }, lease);
}
