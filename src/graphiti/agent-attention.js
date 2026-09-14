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
  return { ...value, items: value.items.map(attentionRecord) };
}

export async function changeAgentAttention(application, operation, input) {
  return attentionRecord(await application.personal.changeAgentAttention(operation, attentionInput(input)));
}
