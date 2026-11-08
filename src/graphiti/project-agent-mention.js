import { addressedAgentId } from './fla-mention.js';

// The stable `#FLA {agentId}` a hand-off or roundtable wake opens with (or a
// legacy `@{uuid}`) selects that Agent in the current scope's directory, never
// another one. Names are matched before this, across the person's whole space
// (task-entry-named-fla.js). Provider authorization still runs after matching,
// including for inactive or client-restricted Agents.
export async function resolveTaskAgentMention(application, projectId, input) {
  const agentId = addressedAgentId(input.taskPrompt);
  if (agentId === null) return null;
  const directory = await application.personal.listProjectAgents(
    application.config.personal.spaceId, projectId);
  const agents = Array.isArray(directory) ? directory : directory.agents ?? directory.items ?? [];
  const failure = status => ({ status, worker_started: false,
    required_action: 'Select an exact Agent in the current scope with #FLA {agentId}; use list_project_agents to resolve names. Do not load a different Agent as fallback.' });
  if (!agents.some(agent => agent.agent_id === agentId)) return failure('agent_not_found');
  if (input.projectAgentId && input.projectAgentId !== agentId) return failure('agent_selection_conflict');
  return { agentId };
}
