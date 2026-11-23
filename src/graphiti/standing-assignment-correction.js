import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';
import { activeTeamAgent, loadProjectTeam } from './project-team-view.js';
import { assertPreviewed, leadName, personsConversation, previewOf, projectNamed, quoted,
  standingAssignmentsOf } from './standing-assignment-confirmation.js';
import { projectDisplayName } from './project-display-name.js';
import { nameableProjects } from './task-entry-project-mention.js';
import { consoleCorrectionSource, isLeadsOwnLine } from './standing-assignment-workstream.js';
import { ID_LIMIT, TERM_LIMIT } from '../standing-assignments/limits.js';

// The person corrects or ends a standing assignment (rec#29 F5, D-41 D7):
// retire stops it routing and frees its terms, reassign points it with its
// terms at another Agent of its project or at another project, edit_terms
// adds or removes terms. In a conversation the assignment is named by one of
// its terms and the change goes through preview and confirm like its
// registration; in the local console the person acted on the record they
// read, so its revision stands in for the digest. Either way the change is
// the person's (source user), recorded as a new revision. The project's own
// lead never changes, and routing and find_agents read the store, so they
// follow at once. A change already in place, such as a confirm sent again
// after it was saved, is answered unchanged before any digest or revision.
//
// A workstream (docs/workstreams.md) is never handed to its project's lead by
// default: it names a member, or it ends. The lead's own change to a line it
// opened applies in one call and stays the lead's; an FLA acting for the
// person in the console is recorded as an Agent and must be that lead.

const PROJECT_NAME_LIMIT = 80;
const NOTHING_TO_CHANGE = 'The standing assignment already is as asked; there is nothing to change.';

export async function correctStandingAssignment(application, input) {
  const plan = await correctionPlan(application, input);
  if (plan.inPlace) {
    return { status: 'unchanged', executed: false, assignment: plan.assignment, restatement: NOTHING_TO_CHANGE };
  }
  if (plan.leadsOwn) {
    if (input.action === 'preview') {
      return { status: 'preview', plan: planView(plan), restatement: restatement(plan), executed: false,
        guidance: 'Your own workstream as its lead: confirm applies it in one call, with no digest and no user yes.' };
    }
    if (plan.change === 'reassign') await assertStillOnTeam(application, plan.correction);
    return { ...standingAssignmentsOf(application).correct(plan.assignmentId, plan.correction,
      { source: 'host', sourceConversationId: plan.sourceConversationId, expectedRevision: plan.revision }),
    executed: false };
  }
  if (input.action === 'preview') return previewOf(plan, planView(plan), restatement(plan));
  assertPreviewed(input, plan);
  // The plan was read across Provider awaits: the new Agent is read again
  // last, with nothing awaited between it and the write.
  if (plan.change === 'reassign') await assertStillOnTeam(application, plan.correction);
  return { ...standingAssignmentsOf(application).correct(plan.assignmentId, plan.correction,
    { source: 'user', sourceConversationId: plan.sourceConversationId, expectedRevision: plan.revision }),
  executed: false };
}

// The console's change of the assignment it shows, at the revision it showed.
// call: the FLA acting for the person (agent-delegation-gate.js), or null for the person's own click.
export async function correctStandingAssignmentInConsole(application, { assignmentId, action, expectedRevision,
  projectId, leadAgentId, addTerms, removeTerms }, call = null) {
  const port = standingAssignmentsOf(application);
  const current = port.get(requiredString(assignmentId, 'assignmentId', ID_LIMIT));
  const source = current ? await consoleCorrectionSource(application, current, call)
    : { source: 'user', sourceConversationId: null };
  const correction = action === 'reassign'
    ? { action, ...await reassignmentTarget(application, requiredString(projectId, 'projectId', ID_LIMIT), leadAgentId,
      current) }
    : { action, addTerms, removeTerms };
  return port.correct(assignmentId, correction, { ...source, expectedRevision });
}

async function correctionPlan(application, input) {
  const port = standingAssignmentsOf(application);
  const task = await personsConversation(application, input);
  const spaceId = application.config.personal.spaceId;
  const term = requiredString(input.term, 'term', TERM_LIMIT);
  // A term no active assignment holds may name the one a correction already changed.
  const held = port.named(spaceId, term);
  const current = held ?? port.lastNamed(spaceId, term);
  if (!current || (!held && current.retiredAt && input.change !== 'retire')) throw unnamed(term);
  // The lead's own line changes in one call and never falls back to the lead;
  // the person's change goes through preview, whose sentence says where it goes.
  const leadsOwn = await isLeadsOwnLine(application, task, current);
  const target = input.change === 'reassign' ? await reassignmentTarget(application, input.projectName === undefined
    ? current.projectId : await namedProjectId(application, input.projectName), input.leadAgentId,
  leadsOwn ? current : null) : null;
  const correction = target ? { action: 'reassign', projectId: target.projectId, leadAgentId: target.leadAgentId }
    : input.change === 'retire' ? { action: 'retire' }
      : { action: 'edit_terms', addTerms: input.addTerms ?? [], removeTerms: input.removeTerms ?? [] };
  const { change, next } = port.previewCorrection(current.assignmentId, correction,
    { source: leadsOwn ? 'host' : 'user', sourceConversationId: task.sessionId });
  if (!change) return { inPlace: true, assignment: current };
  if (!held) throw unnamed(term);
  return { leadsOwn, personalSpaceId: spaceId, sourceConversationId: task.sessionId, assignmentId: current.assignmentId,
    revision: current.revision, change: input.change, correction, from: await ownerOf(application, current),
    to: target ?? null, terms: next.terms, termsBefore: current.terms,
    endsLine: target ? await leavesLedger(application, current, target) : null };
}

// A workstream names a member of its own project; it never falls back to the
// lead, and it is not moved to another project: it ends instead.
async function refuseLineToLead(application, current, projectId, team, leadAgentId) {
  const ownTeam = current.projectId === projectId ? team
    : await loadProjectTeam(application, application.config.personal.spaceId, current.projectId);
  const isLine = Boolean(ownTeam.lead) && current.leadAgentId !== ownTeam.lead.agentId;
  if (!isLine) return;
  if (projectId !== current.projectId) {
    throw new ApplicationError('workstream_stays_in_project', 'A workstream moves only to another member of its own '
      + 'project; end it instead. Nothing was saved.', { status: 422 });
  }
  if (leadAgentId === undefined || leadAgentId === null || leadAgentId === team.lead?.agentId) {
    throw new ApplicationError('workstream_owner_is_lead', 'A workstream goes to a member of this project, never back '
      + 'to its lead by default. Name the member, or end the line to give its work back to the lead. Nothing was '
      + 'saved.', { status: 422 });
  }
}

// The workstream a reassignment takes out of its project's ledger, when it
// goes to that project's lead or to another project (docs/workstreams.md).
async function leavesLedger(application, current, target) {
  const lead = (await loadProjectTeam(application, application.config.personal.spaceId, current.projectId)).lead?.agentId;
  const isLine = Boolean(lead) && current.leadAgentId !== lead;
  return isLine && (target.projectId !== current.projectId || target.leadAgentId === lead) ? current.responsibility : null;
}

function unnamed(term) {
  return new ApplicationError(ApplicationErrorCode.NOT_FOUND, `No active standing assignment has the term "${term}". `
    + 'Nothing was saved.', { status: 404 });
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
async function reassignmentTarget(application, projectId, leadAgentId, current = null) {
  const project = (await nameableProjects(application)).find(item => item.project_id === projectId);
  if (!project) {
    throw new ApplicationError(ApplicationErrorCode.NOT_FOUND, `No project ${projectId} can take this work. Nothing `
      + 'was saved.', { status: 404 });
  }
  const team = await loadProjectTeam(application, application.config.personal.spaceId, projectId);
  if (current) await refuseLineToLead(application, current, projectId, team, leadAgentId);
  const agentId = leadAgentId === undefined || leadAgentId === null ? team.lead?.agentId
    : requiredString(leadAgentId, 'leadAgentId', ID_LIMIT);
  if (!agentId) {
    throw new ApplicationError('standing_assignment_lead_unavailable', `Project ${projectId} has no active lead; name `
      + 'an Agent of it. Nothing was saved.', { status: 409 });
  }
  const agent = activeTeamAgent(team, agentId);
  if (!agent) {
    throw new ApplicationError('standing_assignment_lead_not_in_project', `${agentId} is not an active Agent of project `
      + `${projectId}. Nothing was saved.`, { status: 422 });
  }
  return { projectId, projectName: projectDisplayName(project), leadAgentId: agentId, leadName: agent.name };
}


async function assertStillOnTeam(application, { projectId, leadAgentId }) {
  if (activeTeamAgent(await loadProjectTeam(application, application.config.personal.spaceId, projectId), leadAgentId)) return;
  throw new ApplicationError('standing_assignment_plan_changed', `${leadAgentId} left project ${projectId} while `
    + 'confirming. Nothing was saved; preview again and ask the user again.', { status: 409 });
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

function restatement({ change, from, to, terms, termsBefore, endsLine }) {
  const owner = ({ projectName, leadName: lead }) => `project "${projectName}" (lead "${lead}")`;
  if (change === 'retire') {
    return `FULI will stop sending later tasks that mention ${quoted(termsBefore)} to ${owner(from)}; its history is `
      + 'kept and nothing is done now.';
  }
  if (change === 'reassign') {
    return `FULI will send later tasks that mention ${quoted(terms)} to ${owner(to)} instead of ${owner(from)}`
      + `${endsLine ? `, and "${endsLine}" stops being a workstream of project "${from.projectName}"` : ''}; `
      + 'nothing is done now.';
  }
  return `FULI will send later tasks that mention ${quoted(terms)} to ${owner(from)}, instead of those that mention `
    + `${quoted(termsBefore)}; nothing is done now.`;
}

function planView({ assignmentId, revision, change, from, to, terms }) {
  return { assignmentId, revision, change, from, to, terms };
}
