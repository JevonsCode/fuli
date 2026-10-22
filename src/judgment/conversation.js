import { nativeChoiceInteraction } from '../conversations/human-interaction.js';

// rec#10 D-24: a model's review that may not apply itself reaches the person
// as a suggestion, with the model's own conclusion and reason as reference.
const SUGGESTION = 'AI 建议，待你确认 / AI suggestion, awaiting your decision';

export function judgmentHumanInteraction(records, personalSpaceId) {
  // A suggestion is asked even when the model approved (a manual policy keeps that outcome).
  const record = records.find(item => item.kind === 'review' && (item.outcome === 'escalate' || item.aiReview?.state === 'ai_suggested')
    && !['stale', 'failed'].includes(item.execution?.status));
  if (!record) return {};
  const suggestion = record.aiReview?.state === 'ai_suggested';
  return { human_interaction: nativeChoiceInteraction({
    source: { kind: 'tonborg_review', id: record.id, revision: record.evidenceFingerprint ?? record.createdAt,
      target: record.target, personalSpaceId, personalProjectId: record.personalProjectId ?? null },
    title: record.title ?? '需要补充判断',
    question: suggestion ? `${SUGGESTION} (model: ${record.aiReview.modelOutcome}) ${record.summary}` : record.summary
  }) };
}
