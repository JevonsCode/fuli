import { isOpenQuestion } from './conversation.js';

// The newest delegated reviews a list reads; older ones stay on Tonborg's page.
export const DELEGATED_LIST_LIMIT = 200;

// The newest delegated review of each item (rec#96), split into what Tonborg
// confirmed and the questions it still asks. One the person already voted on,
// undid, or that went stale is done. Full records: the console's list
// (review-delegation.js) and the person's AI (question-tools.js) each decide
// what of them their reader sees.
export function latestDelegatedReviews(store, personalSpaceId, limit) {
  const seen = new Set();
  const confirmed = [], questions = [];
  for (const record of store.delegatedReviews(personalSpaceId, limit)) {
    const subject = `${record.personalProjectId ?? ''}\u0000${record.target}`;
    if (seen.has(subject)) continue;
    seen.add(subject);
    if (record.feedback.vote !== null || record.hard_deleted) continue;
    if (record.execution.status === 'applied') confirmed.push(record);
    else if (isOpenQuestion(record)) questions.push(record);
  }
  return { confirmed, questions };
}
