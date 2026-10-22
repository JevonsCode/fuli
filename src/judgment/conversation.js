import { nativeChoiceInteraction } from '../conversations/human-interaction.js';

// rec#10 D-24: a model's review that may not apply itself reaches the person
// as a suggestion, with the model's own conclusion and reason as reference.
const SUGGESTION = 'AI 建议，待你确认 / AI suggestion, awaiting your decision';

export function judgmentHumanInteraction(records, personalSpaceId) {
  const record = records.find(item => item.kind === 'review' && item.outcome === 'escalate'
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
