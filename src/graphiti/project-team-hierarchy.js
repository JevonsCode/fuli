// Project-local dispatch metadata; this never grants runtime/data authority.
export const subLeadIds = policy => new Set((policy?.sub_teams ?? []).map(group => group.lead_agent_id));
export function reportingParent(policy, id) {
  const root = policy?.team_lead_agent_id;
  if (!root || id === root) return null;
  return (policy.sub_teams ?? []).find(group => (group.member_agent_ids ?? []).includes(id))?.lead_agent_id ?? root;
}
export function dispatchTarget(policy, coordinator, id) {
  if (!policy?.sub_teams?.length || coordinator === id) return id;
  const parent = reportingParent(policy, id);
  if (parent === coordinator) return id;
  return coordinator === policy.team_lead_agent_id && subLeadIds(policy).has(parent) ? parent : null;
}

// This flag is set by the Agent handler, outside model input. Local user HTTP
// maintenance keeps its existing tokenless contract.
export async function requireGroupedAgentTaskContext(application, input) {
  if (!input.agentInvocation) return;
  const policy = await application.personal.getProjectAgentCoordinationPolicy(input.personalSpaceId, input.personalProjectId);
  if (!policy?.sub_teams?.length) return;
  if (!input.taskContextToken) throw new TypeError('Grouped Agent staffing requires the current taskContextToken');
  const context = await application.taskContextRegistry.context(input.taskContextToken, input.sourceApplication);
  if (context.personalProjectId !== input.personalProjectId || !input.sourceSessionId
      || ![context.sessionId, context.sourceSessionId].includes(input.sourceSessionId)) {
    throw new TypeError('Grouped Agent staffing must use this host session and project task');
  }
}
