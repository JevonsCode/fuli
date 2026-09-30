// Only an explicit leading mention selects a role. Matching uses this project's
// directory, never fuzzy search or another Agent's memory. Provider authorization
// still runs after matching, including for inactive or client-restricted names.
export async function resolveTaskAgentMention(application, projectId, input) {
  const prompt = String(input.taskPrompt ?? '').trimStart();
  if (!prompt.startsWith('@')) return null;
  const directory = await application.personal.listProjectAgents(
    application.config.personal.spaceId, projectId);
  const agents = Array.isArray(directory) ? directory : directory.agents ?? directory.items ?? [];
  const raw = prompt.slice(1, 2049);
  const text = normalize(raw);
  const stable = /^\{([^{}\s]+)\}(?=$|[\s,，:：])/u.exec(raw);
  let stableId;
  try { stableId = stable ? decodeURIComponent(stable[1]) : null; }
  catch { stableId = null; }
  const matches = agents.flatMap(agent => {
    const aliases = stable ? [agent.agent_id] : [agent.profile?.display_name, agent.profile?.name, agent.agent_id];
    const lengths = aliases.filter(Boolean).map(name => stable ? name : normalize(name)).filter(name => stable
      ? name === stableId : text.startsWith(name) && /^(?:$|[\s,，:：!?！？])/u.test(text.slice(name.length))).map(name => name.length);
    return lengths.length ? [{ agent, length: Math.max(...lengths) }] : [];
  });
  const longest = Math.max(0, ...matches.map(match => match.length));
  const exact = matches.filter(match => match.length === longest);
  const failure = status => ({ status, worker_started: false,
    required_action: 'Select an exact current-project Agent with @{agentId}; use list_project_agents to resolve names. Do not load a different Agent as fallback.' });
  if (!exact.length) return failure('agent_not_found');
  if (exact.length > 1) return { ...failure('ambiguous_agent'),
    candidates: exact.slice(0, 8).map(({ agent }) => ({ agent_id: agent.agent_id,
      name: agent.profile?.display_name || agent.profile?.name })) };
  const agentId = exact[0].agent.agent_id;
  if (input.projectAgentId && input.projectAgentId !== agentId) return failure('agent_selection_conflict');
  return { agentId };
}

function normalize(value) { return String(value).normalize('NFKC').toLowerCase(); }
