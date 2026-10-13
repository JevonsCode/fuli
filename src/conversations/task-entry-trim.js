// Hook entries are re-sent every turn, so they omit fields that only repeat
// another inline value or report diagnostics the model never acts on. Fields
// that can carry staffing rules, such as match_basis, stay. The MCP fallback
// keeps the complete compact context for explicit recovery.
const MEMORY_ENVELOPE_FIELDS = ['personalSpaceId', 'personalProjectId', 'agentId', 'storage'];

export function withoutRedundantEntryFields(value) {
  if (!value || typeof value !== 'object') return value;
  const context = structuredClone(value);
  if (context.task_context_token === context.taskContextToken) delete context.task_context_token;

  const receipt = context.agent_receipt;
  if (receipt?.owner) delete receipt.owner.profile_url;
  if (receipt?.continuation) {
    if (receipt.continuation.agent_id === receipt.owner?.agent_id) delete receipt.continuation.agent_id;
    if (receipt.continuation.personal_project_id === receipt.personal_project_id) {
      delete receipt.continuation.personal_project_id;
    }
  }

  if (context.context) {
    for (const [key, count] of Object.entries(context.context)) {
      if (key.endsWith('_count') && count === 0) delete context.context[key];
    }
  }

  const agent = context.project_agent_context;
  if (agent && typeof agent === 'object') {
    delete agent.directorySnapshot;
    if (agent.execution_agent_id === agent.project_agent_id) delete agent.execution_agent_id;
    if (agent.execution_reason === agent.selection_reason) delete agent.execution_reason;
    if (agent.personal_project_id === context.context?.personal_project_id) delete agent.personal_project_id;
    if (Array.isArray(agent.unavailable_components) && !agent.unavailable_components.length) {
      delete agent.unavailable_components;
    }
    if (agent.role) {
      if (agent.role.character && Object.values(agent.role.character).every((text) => !text)) {
        delete agent.role.character;
      }
      if (agent.role.expectations === '') delete agent.role.expectations;
    }
    if (agent.project_brief) {
      for (const [key, item] of Object.entries(agent.project_brief)) {
        if (item === null || (Array.isArray(item) && !item.length)) delete agent.project_brief[key];
      }
    }
    for (const layer of ['memory', 'global_memory']) {
      if (!agent[layer] || typeof agent[layer] !== 'object') continue;
      for (const field of MEMORY_ENVELOPE_FIELDS) delete agent[layer][field];
    }
  }
  return context;
}
