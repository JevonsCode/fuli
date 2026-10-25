import { nativeChoiceInteraction } from '../conversations/human-interaction.js';

// rec#10 D-24: a model's review that may not apply itself reaches the person
// as a suggestion, with the model's own conclusion and reason as reference.
const SUGGESTION = 'AI 建议，待你确认 / AI suggestion, awaiting your decision';
const NEEDS_DECISION = 'Tonborg 需要你判断 / Tonborg needs your decision';
// rec#50: an Agent's view carries no reason (agent-view.js); the person reads it in the console.
const REASON_IN_CONSOLE = 'Tonborg 的理由只在 FULI 控制台的 Tonborg 记录里显示 / Tonborg\'s reason is shown only in the FULI console\'s Tonborg records';

export function judgmentHumanInteraction(records, personalSpaceId) {
  // A suggestion is asked even when the model approved (a manual policy keeps that outcome).
  // A review whose item this reader may not see is not its question to ask.
  const record = records.find(item => item.kind === 'review' && (item.outcome === 'escalate' || item.aiReview?.state === 'ai_suggested')
    && !['stale', 'failed'].includes(item.execution?.status) && !item.target_withheld);
  if (!record) return {};
  const suggestion = record.aiReview?.state === 'ai_suggested';
  const conclusion = suggestion ? `${SUGGESTION} (model: ${record.aiReview.modelOutcome})` : null;
  return { human_interaction: nativeChoiceInteraction({
    source: { kind: 'tonborg_review', id: record.id, revision: record.evidenceFingerprint ?? record.createdAt,
      target: record.target, personalSpaceId, personalProjectId: record.personalProjectId ?? null },
    title: record.title ?? '需要补充判断',
    question: record.content_withheld
      ? `${conclusion ?? NEEDS_DECISION}. ${REASON_IN_CONSOLE}`
      : conclusion ? `${conclusion} ${record.summary}` : record.summary
  }) };
}
