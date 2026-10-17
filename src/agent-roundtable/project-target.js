import { ApplicationError } from '../app/application-error.js';

export function projectAddress(to) {
  return typeof to === 'string' && to.startsWith('project:') ? to.slice(8) : null;
}

export async function resolveProjectLead(app, projectId, { source = null, recruit = false } = {}) {
  const space = app.config.personal.spaceId;
  if (!projectId || projectId.length > 128 || projectId.trim() !== projectId) {
    throw new ApplicationError('validation', 'Use an exact project:<projectId> address');
  }
  const project = await app.personal.getPersonalProject(space, projectId);
  if (project.scope_type === 'temporary' || project.profile?.lifecycle === 'archived') {
    throw new ApplicationError('validation', 'Roundtable targets must be active formal projects');
  }
  if (recruit) {
    if (!source?.agent || !source.projectId) throw new ApplicationError('validation', 'An active project lead task is required');
    const policy = await app.personal.getProjectAgentCoordinationPolicy(space, source.projectId);
    if (source.agent.agentId !== policy.team_lead_agent_id) {
      throw new ApplicationError('validation', 'Cross-project requests go through the source lead');
    }
  }
  let policy = await app.personal.getProjectAgentCoordinationPolicy(space, projectId);
  if (!policy.team_lead_agent_id && recruit) {
    const staffing = await app.personal.staffDefaultProjectLead({ personal_space_id: space,
      personal_project_id: projectId, source_application: source.client });
    if (staffing.status !== 'ready') return { projectId, reason: staffing.reason ?? 'awaiting_recruitment', staffing };
    policy = await app.personal.getProjectAgentCoordinationPolicy(space, projectId);
  }
  const agent = policy.team_lead_agent_id
    ? (await app.listProjectAgents({ personalSpaceId: space }))
      .find(a => a.agentId === policy.team_lead_agent_id && a.profile.status === 'active') : null;
  return { projectId, agent, reason: agent ? null : policy.team_lead_agent_id ? 'team_lead_unavailable' : 'project_lead_required' };
}

export async function verifiedProjectFolder(app, projectId, projectPath) {
  if (!projectPath || !app.projectPathResolver) return null;
  try {
    const projects = await app.personal.listPersonalProjects(app.config.personal.spaceId);
    const resolved = app.projectPathResolver(projectPath, projects);
    return resolved.status === 'matched' && resolved.personalProjectId === projectId ? projectPath : null;
  } catch { return null; }
}
