// Tonborg acceptance verdicts as review facts for Bole's score card.
// A verdict counts only when Tonborg actually and independently judged
// another Agent's passed verification: its model or opted-in client ran.
// The lead's own session answering a work package is not independent (C13);
// records from before judgedBy existed count by their client. Escalation
// without that evidence is missing data, not a failed review. Each fact names
// the artifact revision and verification attempt it judged; the Provider
// counts it only while both are still the task's current ones. The user's
// thumbs-down corrects Tonborg: that verdict is disputed and counts neither way.

// Matches the Provider's ProjectAgentScoreCardQuery limit; the newest are kept.
const MAX_REVIEW_VERDICTS = 2000;
const JUDGED_OUTCOMES = Object.freeze({ approve: 'passed', escalate: 'not_passed' });

export function acceptanceReviewVerdicts(records) {
  return records.flatMap(record => {
    const result = verdictResult(record);
    return result ? [{ task_id: record.target, personal_project_id: record.personalProjectId, result,
      artifact_revision: record.artifactRevision, verification_attempt_id: record.verification.attempt_id,
      occurred_at: record.createdAt }] : [];
  }).slice(-MAX_REVIEW_VERDICTS);
}

function verdictResult(record) {
  const judged = record.judgedBy ? record.judgedBy.independent : Boolean(record.client);
  if (!Object.hasOwn(JUDGED_OUTCOMES, record.outcome) || !judged || record.execution.status === 'stale'
    || !record.artifactRevision || !record.verification?.attempt_id) return null;
  return record.feedback.vote === 'down' ? 'disputed' : JUDGED_OUTCOMES[record.outcome];
}
