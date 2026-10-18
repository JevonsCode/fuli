export function agentDiscoveryProfile(agent) {
  return { address: `local:${agent.agentId}`, occupation: agent.occupation?.role ?? null,
    capabilities: agent.profile.capabilities ?? [],
    projects: [...new Set((agent.assignments ?? []).filter(a => a.status === 'active')
      .map(a => a.personalProjectId ?? a.personal_project_id).filter(Boolean))] };
}

export function matchesAgentDiscovery(profile, { occupation = null, capability = null, projectId = null } = {}) {
  const includes = (value, query) => !query || String(value ?? '').toLowerCase().includes(query.trim().toLowerCase());
  return includes(profile.occupation, occupation) && (!projectId || profile.projects?.includes(projectId) || profile.projectId === projectId)
    && (!capability || profile.capabilities?.some(c => includes(c, capability)));
}
