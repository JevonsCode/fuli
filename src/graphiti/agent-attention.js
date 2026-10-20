import { nativeChoiceInteraction } from '../conversations/human-interaction.js';
import { nonEmptyText, requiredString } from '../validation/values.js';

const fields = {
  personalSpaceId: 'personal_space_id', personalProjectId: 'personal_project_id',
  agentId: 'agent_id', taskId: 'task_id', requestId: 'request_id',
  idempotencyKey: 'idempotency_key', requestedAction: 'requested_action',
  expectedRevision: 'expected_revision', respondedBy: 'responded_by',
  createdAt: 'created_at', updatedAt: 'updated_at'
};

export function attentionInput(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [fields[key] ?? key, value]));
}

export function attentionRecord(value) {
  const names = Object.fromEntries(Object.entries(fields).map(([camel, snake]) => [snake, camel]));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [names[key] ?? key, item]));
}

export async function listAgentAttention(application, input) {
  const value = await application.personal.listAgentAttention(attentionInput(input));
  const items = value.items.map(attentionRecord);
  return { ...attentionInteraction(items.find(item => item.status === 'open')), ...value, items };
}

// A linked request is read by its identity, so a page of the open queue never hides it.
export async function getAgentAttention(application, { personalSpaceId, requestId }) {
  return attentionRecord(await application.personal.getAgentAttention(
    requiredString(personalSpaceId, 'personalSpaceId', 128), requiredString(requestId, 'requestId', 128)));
}

export async function changeAgentAttention(application, operation, input) {
  const record = attentionRecord(await application.personal.changeAgentAttention(operation, attentionInput(input)));
  return { ...attentionInteraction(record), ...record };
}

// The console sends the chosen option and an optional note; the Provider keeps
// them as one response text, and the requesting Agent receives both.
export async function respondToAgentAttention(application, { choice, note, ...input }) {
  const answer = { choice: nonEmptyText(choice), note: nonEmptyText(note) };
  if (!answer.choice && !answer.note) throw new TypeError('An attention reply needs a choice or a note');
  const record = await changeAgentAttention(application, 'respond', { ...input,
    response: [answer.choice, answer.note].filter(Boolean).join('\n\n') });
  return { ...record, delivery: await deliverAnswer(application, record, answer) };
}

// The reply is already recorded; a failed delivery leaves it readable through
// list_agent_attention and is reported, never hidden.
async function deliverAnswer(application, record, answer) {
  const unavailable = { status: 'unavailable', agentId: record.agentId };
  if (!application.roundtable) return unavailable;
  try { return await application.roundtable.deliverAttentionReply(record, answer); }
  catch { return unavailable; }
}

function attentionInteraction(record) {
  if (record?.status !== 'open') return {};
  return { human_interaction: nativeChoiceInteraction({
    source: { kind: 'agent_attention', id: record.requestId, revision: record.revision,
      personalSpaceId: record.personalSpaceId, personalProjectId: record.personalProjectId },
    title: record.title, question: record.requestedAction, options: record.options
  }) };
}
