import { RoundtableError } from '../errors.js';

export function projectAddress(to) {
  return typeof to === 'string' && to.startsWith('project:') ? to.slice(8) : null;
}

export async function resolveProjectLead(host, projectId, { source = null, recruit = false } = {}) {
  if (!projectId || projectId.length > 128 || projectId.trim() !== projectId) {
    throw new RoundtableError('validation', 'Use an exact project:<projectId> address');
  }
  const project = await host.getProject(projectId);
  if (project.temporary || project.archived) {
    throw new RoundtableError('validation', 'Roundtable targets must be active formal projects');
  }
  if (recruit) {
    if (!source?.agent || !source.projectId) throw new RoundtableError('validation', 'An active project lead task is required');
    if (source.agent.agentId !== await host.projectLeadId(source.projectId)) {
      throw new RoundtableError('validation', 'Cross-project requests go through the source lead');
    }
  }
  let leadId = await host.projectLeadId(projectId);
  if (!leadId && recruit) {
    const staffing = await host.staffProjectLead({ projectId, client: source.client });
    if (staffing.status !== 'ready') return { projectId, reason: staffing.reason ?? 'awaiting_recruitment', staffing };
    leadId = await host.projectLeadId(projectId);
  }
  const agent = leadId
    ? (await host.listAgents()).find(a => a.agentId === leadId && a.profile.status === 'active') : null;
  return { projectId, agent, reason: agent ? null : leadId ? 'team_lead_unavailable' : 'project_lead_required' };
}

export async function verifiedProjectFolder(host, projectId, projectPath) {
  if (!projectPath) return null;
  try {
    return await host.projectForPath(projectPath) === projectId ? projectPath : null;
  } catch { return null; }
}
