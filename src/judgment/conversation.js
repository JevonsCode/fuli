import { nativeChoiceInteraction } from '../conversations/human-interaction.js';

export function judgmentHumanInteraction(records, personalSpaceId) {
  const record = records.find(item => item.kind === 'review' && item.outcome === 'escalate'
    && !['stale', 'failed'].includes(item.execution?.status));
  if (!record) return {};
  return { human_interaction: nativeChoiceInteraction({
    source: { kind: 'tonborg_review', id: record.id, revision: record.evidenceFingerprint ?? record.createdAt,
      target: record.target, personalSpaceId, personalProjectId: record.personalProjectId ?? null },
    title: record.title ?? '需要补充判断', question: record.summary
  }) };
}
