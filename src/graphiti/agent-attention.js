import { nativeChoiceInteraction } from '../conversations/human-interaction.js';

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

export async function changeAgentAttention(application, operation, input) {
  const record = attentionRecord(await application.personal.changeAgentAttention(operation, attentionInput(input)));
  return { ...attentionInteraction(record), ...record };
}

function attentionInteraction(record) {
  if (record?.status !== 'open') return {};
  return { human_interaction: nativeChoiceInteraction({
    source: { kind: 'agent_attention', id: record.requestId, revision: record.revision,
      personalSpaceId: record.personalSpaceId, personalProjectId: record.personalProjectId },
    title: record.title, question: record.requestedAction, options: record.options
  }) };
}
