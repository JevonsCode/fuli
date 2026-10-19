// Tonborg acceptance verdicts as review facts for Bole's score card.
// A verdict counts only when Tonborg actually judged another Agent's passed
// verification (its client ran) on evidence that is still current. Escalation
// without that evidence is missing data, not a failed review. The user's
// thumbs-down corrects Tonborg: that verdict is disputed and counts neither way.

// Matches the Provider's ProjectAgentScoreCardQuery limit; the newest are kept.
const MAX_REVIEW_VERDICTS = 2000;
const JUDGED_OUTCOMES = Object.freeze({ approve: 'passed', escalate: 'not_passed' });

export function acceptanceReviewVerdicts(records) {
  return records.flatMap(record => {
    const result = verdictResult(record);
    return result ? [{ task_id: record.target, personal_project_id: record.personalProjectId,
      result, occurred_at: record.createdAt }] : [];
  }).slice(-MAX_REVIEW_VERDICTS);
}

function verdictResult(record) {
  if (!Object.hasOwn(JUDGED_OUTCOMES, record.outcome) || !record.client || record.execution.status === 'stale') return null;
  return record.feedback.vote === 'down' ? 'disputed' : JUDGED_OUTCOMES[record.outcome];
}
