import { nativeChoiceInteraction } from '../conversations/human-interaction.js';

// rec#10 D-24: a model's review that may not apply itself reaches the person
// as a suggestion, with the model's own conclusion and reason as reference.
const SUGGESTION = 'AI 建议，待你确认 / AI suggestion, awaiting your decision';
// rec#26: why the host escalated, whatever the model concluded. It names a
// pattern match only; a candidate without one is not thereby safe (D-56).
const INJECTION_NOTE = '宿主预检：候选文本匹配已知注入格式 / Host pre-check: the candidate\'s text matches a known injection pattern';
const BATCH_NOTE = '宿主预检：同批候选匹配已知注入格式 / Host pre-check: another candidate reviewed in the same request matches a known injection pattern. ';
const NEEDS_DECISION = 'Tonborg 需要你判断 / Tonborg needs your decision';
// rec#50: an Agent's view carries no reason (agent-view.js); the person reads it in the console.
const REASON_IN_CONSOLE = 'Tonborg 的理由只在 FULI 控制台的 Tonborg 记录里显示 / Tonborg\'s reason is shown only in the FULI console\'s Tonborg records';

// rec#96: with 「交给 Tonborg 确认」 on, what Tonborg could not decide reaches
// the person as ONE short batch, each item as Tonborg's guess, never one
// question per item. The guesses and their one-click answers live in the
// console's 待决策 list: an Agent cannot confirm, drop or edit knowledge for
// the person, and an Agent's view of a record carries none of its words.
const BATCH_TITLE = 'Tonborg 想跟你确认几件事 / Tonborg has a few questions for you';
const BATCH_OPTIONS = ['去 FULI 待决策里看 Tonborg 的猜测 / See Tonborg\'s guesses in FULI 待决策', '稍后 / Later'];
const BATCH_GUIDANCE = 'Ask once, with the host native single-choice UI. The person answers each guess with one click in the FULI console\'s '
  + '待决策 list; do not confirm, drop or edit these knowledge items yourself, and do not ask about them one by one. An answer is intent, '
  + 'not an approval token. Continue unrelated work.';
const BATCH_LINES = 5;

// A delegated review Tonborg left to the person and that still stands.
export function isOpenQuestion(record) {
  return record.kind === 'review' && record.delegated === true && record.feedback?.vote === null
    && (record.outcome === 'escalate' || record.aiReview?.state === 'ai_suggested')
    && !['stale', 'failed', 'undone', 'applied'].includes(record.execution?.status);
}

function batchInteraction(batch, personalSpaceId) {
  const words = batch.filter(record => record.question && !record.content_withheld).map(record => record.question);
  const listed = words.slice(0, BATCH_LINES).map((question, index) => `${index + 1}. ${question}`);
  const more = batch.length - listed.length;
  const question = listed.length
    ? [...listed, ...(more > 0 ? [`… +${more}`] : [])].join('\n')
    : `Tonborg 有 ${batch.length} 条拿不准，猜测写在 FULI 待决策里 / Tonborg is unsure about ${batch.length} items; its guesses are in FULI 待决策`;
  return nativeChoiceInteraction({
    source: { kind: 'tonborg_review', id: batch[0].id, revision: batch.map(record => record.id).join(','),
      batch: batch.map(record => record.id), personalSpaceId, personalProjectId: null },
    title: BATCH_TITLE, question, options: BATCH_OPTIONS, guidance: BATCH_GUIDANCE });
}

export function judgmentHumanInteraction(records, personalSpaceId) {
  const batch = records.filter(record => isOpenQuestion(record) && !record.target_withheld);
  if (batch.length) return { human_interaction: batchInteraction(batch, personalSpaceId) };
  // A suggestion is asked even when the model approved (a manual policy keeps that outcome).
  // A review whose item this reader may not see is not its question to ask.
  const record = records.find(item => item.kind === 'review' && (item.outcome === 'escalate' || item.aiReview?.state === 'ai_suggested')
    && !['stale', 'failed'].includes(item.execution?.status) && !item.target_withheld);
  if (!record) return {};
  const suggestion = record.aiReview?.state === 'ai_suggested';
  const signals = record.aiReview?.injectionSignals ?? [];
  const note = signals.length ? `${INJECTION_NOTE} (${signals.join(', ')}). ` : record.aiReview?.injectionInBatch ? BATCH_NOTE : '';
  const conclusion = suggestion ? `${SUGGESTION} (model: ${record.aiReview.modelOutcome})` : null;
  return { human_interaction: nativeChoiceInteraction({
    source: { kind: 'tonborg_review', id: record.id, revision: record.evidenceFingerprint ?? record.createdAt,
      target: record.target, personalSpaceId, personalProjectId: record.personalProjectId ?? null },
    title: record.title ?? '需要补充判断',
    question: record.content_withheld
      ? `${note}${conclusion ?? NEEDS_DECISION}. ${REASON_IN_CONSOLE}`
      : conclusion ? `${note}${conclusion} ${record.summary}` : record.summary
  }) };
}
