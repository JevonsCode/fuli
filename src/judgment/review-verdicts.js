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
  return judgedAcceptances(records).map(judged => ({ task_id: judged.taskId, personal_project_id: judged.personalProjectId,
    result: judged.result, artifact_revision: judged.artifactRevision, verification_attempt_id: judged.verification.attempt_id,
    occurred_at: judged.at })).slice(-MAX_REVIEW_VERDICTS);
}

// The same verdicts with what the verification states (src/fla-growth/)
// show: the attempt's evidence and, when recorded, the hashed task context
// key the recall impressions join on.
export function judgedAcceptances(records) {
  return records.flatMap(record => {
    const result = verdictResult(record);
    return result ? [{ decisionId: record.id, taskId: record.target, personalProjectId: record.personalProjectId, result,
      artifactRevision: record.artifactRevision, verification: record.verification, taskKey: record.taskKey ?? null,
      at: record.createdAt }] : [];
  });
}

function verdictResult(record) {
  const judged = record.judgedBy ? record.judgedBy.independent : Boolean(record.client);
  if (!Object.hasOwn(JUDGED_OUTCOMES, record.outcome) || !judged || record.execution.status === 'stale'
    || !record.artifactRevision || !record.verification?.attempt_id) return null;
  return record.feedback.vote === 'down' ? 'disputed' : JUDGED_OUTCOMES[record.outcome];
}
