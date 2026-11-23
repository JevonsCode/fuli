import { loadProjectTeam } from './project-team-view.js';
import { nameableProjects, projectDisplayName } from './task-entry-project-mention.js';
import { withWorkstreamProgress } from './workstream-ledger.js';

// The console's ledger reads (docs/workstreams.md), on this computer only.

/** One project's lines with how far each got, for its project page. */
export async function projectWorkstreamLedger(application, personalSpaceId, projectId) {
  const team = await loadProjectTeam(application, personalSpaceId, projectId, { withProgress: true });
  return { personalProjectId: projectId, workstreams: team.workstreams };
}

/**
 * One FLA's ledger across projects, for the console widget: every line of a
 * project it leads, and every line it owns itself, whether or not it is still
 * on that project. A line says which project and who, so the widget needs
 * nothing of where it sits but the FLA.
 */
export async function agentWorkstreamLedger(application, personalSpaceId, agentId) {
  const assignments = application.standingAssignments?.list(personalSpaceId) ?? [];
  const projectIds = [...new Set(assignments.filter(item => !item.retiredAt).map(item => item.projectId))];
  if (!projectIds.length) return { agentId, projects: [] };
  const [teams, projects] = await Promise.all([
    Promise.all(projectIds.map(projectId => loadProjectTeam(application, personalSpaceId, projectId)
      .then(team => ({ projectId, team }), () => null))),
    nameableProjects(application).catch(() => [])
  ]);
  const names = new Map(projects.map(project => [project.project_id, projectDisplayName(project)]));
  const mine = teams.filter(Boolean).filter(({ team }) => team.lead?.agentId === agentId
    || team.workstreams.some(line => line.ownerAgentId === agentId));
  const read = await Promise.all(mine.map(async ({ projectId, team }) => ({
    projectId,
    projectName: names.get(projectId) ?? projectId,
    // On the page of an FLA that is not this project's lead, only its own lines.
    leads: team.lead?.agentId === agentId,
    workstreams: await withWorkstreamProgress(application, personalSpaceId, projectId,
      team.lead?.agentId === agentId ? team.workstreams
        : team.workstreams.filter(line => line.ownerAgentId === agentId))
  })));
  return { agentId, projects: read.filter(project => project.workstreams.length) };
}
