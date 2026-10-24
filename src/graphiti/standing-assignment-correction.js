import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';
import { loadProjectTeam } from './project-team-view.js';
import { assertPreviewed, leadName, personsConversation, previewOf, projectNamed, quoted,
  standingAssignmentsOf } from './standing-assignment-confirmation.js';
import { nameableProjects, projectDisplayName } from './task-entry-project-mention.js';

// The person corrects or ends a standing assignment (rec#29 F5, D-41 D7):
// retire stops it routing and frees its terms, reassign points it with its
// terms at another Agent of its project or at another project, edit_terms
// adds or removes terms. In a conversation the assignment is named by one of
// its terms and the change goes through preview and confirm like its
// registration; in the local console the person acted on the record they
// read, so its revision stands in for the digest. Either way the change is
// the person's (source user), recorded as a new revision. The project's own
// lead never changes, and routing and find_agents read the store, so they
// follow at once.

const TERM_LIMIT = 80;
const PROJECT_NAME_LIMIT = 80;
const ID_LIMIT = 200;
const CONFIRMED = Object.freeze({ retire: 'retired', reassign: 'reassigned', edit_terms: 'terms_edited' });

export async function correctStandingAssignment(application, input) {
  const plan = await correctionPlan(application, input);
  if (input.action === 'preview') return previewOf(plan, planView(plan), restatement(plan));
  assertPreviewed(input, plan);
  const assignment = standingAssignmentsOf(application).correct(plan.assignmentId, plan.correction,
    { source: 'user', sourceConversationId: plan.sourceConversationId, expectedRevision: plan.revision });
  return { status: CONFIRMED[plan.change], executed: false, assignment };
}

// The console's change of the assignment it shows, at the revision it showed.
export async function correctStandingAssignmentInConsole(application, { assignmentId, action, expectedRevision,
  projectId, leadAgentId, addTerms, removeTerms }) {
  const port = standingAssignmentsOf(application);
  const correction = action === 'reassign'
    ? { action, ...await reassignmentTarget(application, requiredString(projectId, 'projectId', ID_LIMIT), leadAgentId) }
    : { action, addTerms, removeTerms };
  return port.correct(assignmentId, correction, { source: 'user', sourceConversationId: null, expectedRevision });
}

async function correctionPlan(application, input) {
  const port = standingAssignmentsOf(application);
  const task = await personsConversation(application, input);
  const spaceId = application.config.personal.spaceId;
  const term = requiredString(input.term, 'term', TERM_LIMIT);
  const current = port.named(spaceId, term);
  if (!current) {
    throw new ApplicationError(ApplicationErrorCode.NOT_FOUND, `No active standing assignment has the term "${term}". `
      + 'Nothing was saved.', { status: 404 });
  }
  const target = input.change === 'reassign' ? await reassignmentTarget(application, input.projectName === undefined
    ? current.projectId : await namedProjectId(application, input.projectName), input.leadAgentId) : null;
  const correction = target ? { action: 'reassign', projectId: target.projectId, leadAgentId: target.leadAgentId }
    : input.change === 'retire' ? { action: 'retire' }
      : { action: 'edit_terms', addTerms: input.addTerms ?? [], removeTerms: input.removeTerms ?? [] };
  const { next } = port.previewCorrection(current.assignmentId, correction,
    { source: 'user', sourceConversationId: task.sessionId });
  return { personalSpaceId: spaceId, sourceConversationId: task.sessionId, assignmentId: current.assignmentId,
    revision: current.revision, change: input.change, correction, from: await ownerOf(application, current),
    to: target ?? null, terms: next.terms, termsBefore: current.terms };
}

async function namedProjectId(application, name) {
  const projectId = await projectNamed(application, requiredString(name, 'projectName', PROJECT_NAME_LIMIT));
  if (projectId) return projectId;
  throw new ApplicationError(ApplicationErrorCode.NOT_FOUND, `No project is named "${name}". Nothing was saved.`,
    { status: 404 });
}

// The project and the Agent work would go to: the named Agent or, without
// one, the project's lead, active on that project either way. The person's
// choice for this work never changes who leads the project.
async function reassignmentTarget(application, projectId, leadAgentId) {
  const spaceId = application.config.personal.spaceId;
  const project = (await nameableProjects(application)).find(item => item.project_id === projectId);
  if (!project) {
    throw new ApplicationError(ApplicationErrorCode.NOT_FOUND, `No project ${projectId} can take this work. Nothing `
      + 'was saved.', { status: 404 });
  }
  const team = await loadProjectTeam(application, spaceId, projectId);
  const agentId = leadAgentId === undefined || leadAgentId === null ? team.lead?.agentId
    : requiredString(leadAgentId, 'leadAgentId', ID_LIMIT);
  if (!agentId) {
    throw new ApplicationError('standing_assignment_lead_unavailable', `Project ${projectId} has no active lead; name `
      + 'an Agent of it. Nothing was saved.', { status: 409 });
  }
  const agent = [team.lead, ...team.members, ...team.collaborators].find(person => person?.agentId === agentId);
  if (!agent) {
    throw new ApplicationError('standing_assignment_lead_not_in_project', `${agentId} is not an active Agent of project `
      + `${projectId}. Nothing was saved.`, { status: 422 });
  }
  return { projectId, projectName: projectDisplayName(project), leadAgentId: agentId, leadName: agent.name };
}

// Where the assignment sends work now, named for the person. A lead that
// is gone keeps its ID, so the person can still end or move its work.
async function ownerOf(application, { projectId, leadAgentId }) {
  const spaceId = application.config.personal.spaceId;
  const project = (await nameableProjects(application)).find(item => item.project_id === projectId);
  const name = await leadName(application, spaceId, projectId, leadAgentId).catch(error => {
    if (error?.status === 404) return leadAgentId;
    throw error;
  });
  return { projectId, projectName: project ? projectDisplayName(project) : projectId, leadAgentId, leadName: name };
}

function restatement({ change, from, to, terms, termsBefore }) {
  const owner = ({ projectName, leadName: lead }) => `project "${projectName}" (lead "${lead}")`;
  if (change === 'retire') {
    return `FULI will stop sending later tasks that mention ${quoted(termsBefore)} to ${owner(from)}; its history is `
      + 'kept and nothing is done now.';
  }
  if (change === 'reassign') {
    return `FULI will send later tasks that mention ${quoted(terms)} to ${owner(to)} instead of ${owner(from)}; `
      + 'nothing is done now.';
  }
  return `FULI will send later tasks that mention ${quoted(terms)} to ${owner(from)}, instead of those that mention `
    + `${quoted(termsBefore)}; nothing is done now.`;
}

function planView({ assignmentId, revision, change, from, to, terms }) {
  return { assignmentId, revision, change, from, to, terms };
}
