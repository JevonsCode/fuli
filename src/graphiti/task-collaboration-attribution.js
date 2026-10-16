// Only the Provider's frozen checkpoint snapshot proves worker participation.
// Candidate IDs never create evidence, and legacy/unknown snapshots stay empty.
export async function taskTeam(application, task, collaboratorIds) {
  const requested = [...new Set(collaboratorIds)].filter(id => id !== task.projectAgentId);
  const snapshot = task.checkpoint?.collaboration;
  const valid = snapshot?.version === 1 && snapshot.status === 'frozen' &&
    snapshot.owner?.agent_id === task.projectAgentId && Array.isArray(snapshot.collaborators);
  const proven = valid ? snapshot.collaborators.filter(item => typeof item.agent_id === 'string' &&
    item.agent_id !== task.projectAgentId && Array.isArray(item.runs) && item.runs.length > 0) : [];
  const unique = new Map(proven.map(item => [item.agent_id, item]));
  const legacy = !snapshot || (snapshot.version === 1 && snapshot.status === 'legacy_unknown');
  let name = valid ? snapshot.owner.name : null;
  if (legacy && snapshot?.owner?.agent_id === task.projectAgentId) name = snapshot.owner.name ?? null;
  if (legacy && !(typeof name === 'string' && name.trim()) && task.projectAgentId) {
    try {
      const owner = await application.personal.getProjectAgent(
        application.config.personal.spaceId, task.personalProjectId, task.projectAgentId);
      name = owner?.profile?.display_name || owner?.profile?.name || null;
    } catch { /* Missing display metadata cannot undo a checkpoint or change its owner. */ }
  }
  return { name,
    collaborators: [...unique.values()].map(item => ({ agentId: item.agent_id, name: item.name })),
    ignored: requested.filter(id => !unique.has(id)) };
}
