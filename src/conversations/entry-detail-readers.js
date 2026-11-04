// The read call that returns an entry detail in full. An entry that shows a
// detail only as a count or pointer names its reader here, so the inline fit
// (entry-inline-budget.js) and the token-less view (task-context-view.js)
// point to the same calls with the IDs the entry already holds.
const present = values => Object.fromEntries(Object.entries(values).filter(([, item]) => item !== undefined));

// One working-memory layer: the project layer, or the global one with null.
export function memoryRead(value, personalProjectId) {
  return { tool: 'get_project_agent_memory', arguments: present({ personalSpaceId: value.context?.personal_space_id,
    personalProjectId, agentId: value.context?.project_agent_id ?? value.project_agent_context?.project_agent_id }) };
}

export function teamRead(value) {
  return { tool: 'get_project_team', arguments: present({ personalSpaceId: value.context?.personal_space_id,
    personalProjectId: value.context?.personal_project_id ?? value.project_agent_context?.personal_project_id }) };
}

// A manager's tools and schemas; its board is then read through them.
export function managerRead(manager) {
  return manager.read ?? { tool: manager.tools?.discover ?? 'list_employee_tools',
    arguments: { templateId: manager.template_id, personalProjectId: manager.personal_project_id } };
}
