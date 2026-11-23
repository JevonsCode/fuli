import { InvalidInputError } from '../app/application-error.js';
import { runWithCallerWorkspaces } from '../graphiti/caller-workspace.js';
import { resolvePersonalProjectPath } from '../graphiti/project-path-context.js';
import { listPersonalProjects } from '../graphiti/personal-projects.js';
import { projectLead } from '../graphiti/standing-assignment-confirmation.js';
import { parseWorkspaceFacts, workspaceFileSystem } from '../graphiti/workspace-facts.js';

// "Which space and project is this folder, and which FLA leads it" — the one
// read an outside process needs and could not get, so it wrote FULI_SPACE_ID by
// hand instead (rec#145). Read only, and never a token, a provider URL or a
// certificate: only names and IDs a person already sees in the console.
//
// app: the federated graph application. projectPath: an absolute folder.
// personalProjectId: a project chosen by ID instead. workspace: the folder's
// facts when it is on another computer (a runner, workspace-facts.js), so the
// same resolution rules run on the host.
export async function projectIdentity(app, { projectPath = null, personalProjectId = null, workspace = null } = {}) {
  if (projectPath !== null && personalProjectId !== null) {
    throw new InvalidInputError('Name a folder or a project ID, not both');
  }
  const spaceId = app.config.personal.spaceId;
  const [spaces, projects] = await Promise.all([app.personal.listSpaces(), listPersonalProjects(app, { personalSpaceId: spaceId })]);
  const space = { id: spaceId, name: spaces.find(({ id }) => id === spaceId)?.name ?? null };
  const resolution = personalProjectId
    ? { status: 'matched', basis: 'project_id', personalProjectId }
    : resolveFolder(projectPath, projects, workspace);
  if (resolution.status !== 'matched') {
    return { space, project: null, lead: null, projectResolution: resolution.status, basis: resolution.basis ?? null };
  }
  const project = projects.find(({ project_id: id }) => id === resolution.personalProjectId) ?? null;
  if (!project) return { space, project: null, lead: null, projectResolution: 'unmatched', basis: null };
  const leadId = await projectLead(app, spaceId, project.project_id);
  return {
    space,
    project: { id: project.project_id, name: project.profile?.name ?? project.project_id },
    lead: leadId ? await leadOf(app, spaceId, project.project_id, leadId) : null,
    projectResolution: 'matched',
    basis: resolution.basis ?? null
  };
}

// An FLA's own name is its profile's display_name; profile.name is its role
// (project-team-view.js shows them in that order too). A script signing
// "—— FLA <name>" needs the person's name, not the job title.
async function leadOf(app, spaceId, projectId, agentId) {
  const profile = (await app.personal.getProjectAgent(spaceId, projectId, agentId))?.profile ?? {};
  return { id: agentId, name: profile.display_name || profile.name || agentId, role: profile.name ?? null };
}

// A folder on this computer reads its own disk; a runner's reads the facts it sent.
function resolveFolder(projectPath, projects, workspace) {
  if (!workspace) return resolvePersonalProjectPath(projectPath, projects);
  const facts = parseWorkspaceFacts(workspace);
  return runWithCallerWorkspaces(() => facts, () => resolvePersonalProjectPath(projectPath, projects, workspaceFileSystem(facts)));
}
