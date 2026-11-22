import { ApplicationError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';
import { loadProjectTeam } from './project-team-view.js';
import { personsConversation, projectLead, quoted, standingAssignmentsOf } from './standing-assignment-confirmation.js';

// A project lead gives one line of work in its own project to one member
// (docs/workstreams.md): several small projects, pages or campaigns share a
// repository, a release process and components while their business logic has
// nothing in common, so each belongs to its own FLA instead of piling up on
// the lead. The record is an ordinary standing assignment whose Agent is that
// member, so routing, corrections and history are the ones that already exist.
//
// The lead decides this, not the person, so it is recorded as the host's
// (source host) in one call: the person is not asked to confirm a split they
// already said should happen. What the person confirmed still outranks it —
// the store refuses a host change to a user-sourced assignment, and the
// person's own registration of this one makes it theirs. Nothing is executed.

const RESPONSIBILITY_LIMIT = 240;
const ID_LIMIT = 200;
const NOT_EXECUTED = 'Recorded, NOT executed: no task was started or done. Later tasks of this project whose words '
  + 'or working folder name these terms go to this FLA.';

export async function delegateWorkstream(application, input) {
  const port = standingAssignmentsOf(application);
  const task = await personsConversation(application, input);
  const spaceId = application.config.personal.spaceId;
  const projectId = task.personalProjectId;
  if (!projectId) {
    throw refusal('workstream_project_required', 'This task belongs to no project, so it has no workstreams. '
      + 'Nothing was saved.', 422);
  }
  const lead = await projectLead(application, spaceId, projectId);
  if (!lead) {
    throw refusal('workstream_lead_required', `Project ${projectId} has no active lead to divide its work. `
      + 'Nothing was saved.', 409);
  }
  if (task.projectAgentId !== lead) {
    throw refusal('workstream_lead_only', 'Only this project\'s lead divides its work into workstreams. Nothing was '
      + 'saved; ask the lead, or have the person say it in their own words (change register).', 403);
  }
  const ownerAgentId = requiredString(input.leadAgentId, 'leadAgentId', ID_LIMIT);
  if (ownerAgentId === lead) {
    throw refusal('workstream_owner_is_lead', 'A workstream separates a line of work from the lead; name a member of '
      + 'this project instead. Work that stays with the lead needs no workstream. Nothing was saved.', 422);
  }
  const owner = await projectMember(application, spaceId, projectId, ownerAgentId);
  const registration = { personalSpaceId: spaceId, projectId, leadAgentId: ownerAgentId, terms: input.terms,
    responsibility: requiredString(input.responsibility, 'responsibility', RESPONSIBILITY_LIMIT),
    source: 'host', sourceConversationId: task.sessionId };
  if (input.action === 'preview') {
    const plan = port.preview(registration);
    return { status: 'preview', executed: false, workstream: view(plan.responsibility, plan.terms, owner),
      restatement: restatement(plan.status, plan.responsibility, plan.terms, owner) };
  }
  const { status, assignment } = port.register(registration);
  return { status, executed: false, notice: NOT_EXECUTED,
    workstream: { ...view(assignment.responsibility, assignment.terms, owner),
      assignment_id: assignment.assignmentId, revision: assignment.revision } };
}

// The person opens a workstream in the local console, on the project page
// they are reading. Theirs (source user), so a lead cannot change it later.
export async function createWorkstreamInConsole(application, { personalProjectId, leadAgentId, terms,
  responsibility }) {
  const port = standingAssignmentsOf(application);
  const spaceId = application.config.personal.spaceId;
  const projectId = requiredString(personalProjectId, 'personalProjectId', ID_LIMIT);
  const ownerAgentId = requiredString(leadAgentId, 'leadAgentId', ID_LIMIT);
  if (ownerAgentId === await projectLead(application, spaceId, projectId)) {
    throw refusal('workstream_owner_is_lead', 'A workstream separates a line of work from the lead; name a member of '
      + 'this project instead. Nothing was saved.', 422);
  }
  const owner = await projectMember(application, spaceId, projectId, ownerAgentId);
  const { status, assignment } = port.register({ personalSpaceId: spaceId, projectId, leadAgentId: ownerAgentId,
    terms, responsibility: requiredString(responsibility, 'responsibility', RESPONSIBILITY_LIMIT),
    source: 'user', sourceConversationId: null });
  return { status, workstream: { ...view(assignment.responsibility, assignment.terms, owner),
    assignment_id: assignment.assignmentId, revision: assignment.revision } };
}

// The Agent must work on this project now: a member, or an Agent assigned to
// it outside the explicit roster. The project's own lead never changes.
async function projectMember(application, spaceId, projectId, agentId) {
  const team = await loadProjectTeam(application, spaceId, projectId);
  const member = [...team.members, ...team.collaborators].find(person => person.agentId === agentId);
  if (member) return { agentId, name: member.name };
  throw refusal('workstream_owner_not_in_project', `${agentId} is not an active Agent of this project. Add it to the `
    + 'project first (create_project_agent_assignment), or have AR find one. Nothing was saved.', 422);
}

function view(workstream, terms, owner) {
  return { workstream, terms, owner_agent_id: owner.agentId, owner_name: owner.name };
}

function restatement(status, workstream, terms, owner) {
  if (status === 'unchanged') return `"${workstream}" already goes to ${owner.name}; there is nothing to record.`;
  return `FULI will send later tasks of this project that mention ${quoted(terms)}, or run in a folder of that name, `
    + `to ${owner.name} as the workstream "${workstream}"; nothing is done now.`;
}

function refusal(code, message, status) {
  return new ApplicationError(code, message, { status });
}
