import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { ID_LIMIT, RESPONSIBILITY_LIMIT } from '../standing-assignments/limits.js';
import { isBranchTerm } from '../standing-assignments/term-rules.js';
import { identityKey } from '../text/name-identity.js';
import { requiredString } from '../validation/values.js';
import { activeTeamAgent, loadProjectTeam } from './project-team-view.js';
import { personsConversation, projectLead, quoted, standingAssignmentsOf } from './standing-assignment-confirmation.js';

// A project's lines of work (docs/workstreams.md): several small projects,
// pages or campaigns share a repository, a release process and components
// while their business logic has nothing in common, so each belongs to its own
// FLA instead of piling up on the lead. A line is a standing assignment of the
// project whose Agent is a member other than the lead.
//
// Who decides is recorded honestly. The lead opens and corrects its own lines
// in one call, recorded as the host's; the person's clicks in the console are
// the person's; an FLA acting for the person in the console
// (run_delegated_action) is an Agent, recorded as the host's, and may do it
// only as that project's lead. What the person opened or confirmed outranks
// what an Agent decided: the store refuses an Agent's change to it.

const NOT_EXECUTED = 'Recorded, NOT executed: no task was started or done. Later tasks of this project whose words, '
  + 'folder or branch name these terms go to this FLA, which works them as itself. Tell the person tell_user once, '
  + 'in their language: you opened this line on your own and they can change or end it on the project page.';

// change delegate: the calling task's project lead opens a line in one call.
export async function delegateWorkstream(application, input) {
  const port = standingAssignmentsOf(application);
  const task = await personsConversation(application, input);
  const { projectId } = await asLeadOf(application, task.personalProjectId, task.projectAgentId);
  const owner = await lineOwner(application, projectId, requiredString(input.leadAgentId, 'leadAgentId', ID_LIMIT));
  // Only the terms the lead named: the branch its session is on is a term
  // only when it names one (branch:<name>), never added on its own.
  const registration = lineRegistration(application, { projectId, owner, terms: input.terms,
    responsibility: input.responsibility, source: 'host', sourceConversationId: task.sessionId });
  if (input.action === 'preview') {
    const plan = port.previewOpen(registration);
    const { words, branches } = byKind(plan.terms);
    return { status: 'preview', executed: false, workstream: view(plan.responsibility, plan.terms, owner),
      restatement: `FULI will send later tasks of this project ${words.length ? `that name ${quoted(words)} `
        : ''}to ${owner.name} as the workstream "${plan.responsibility}", who works them as itself; nothing is done now.`
        + (branches.length ? ` Every task on the branch ${quoted(branches)} goes there too, whatever it says.` : '') };
  }
  const { assignment } = port.open(registration);
  const { words, branches } = byKind(assignment.terms);
  return { status: 'created', executed: false, notice: NOT_EXECUTED, workstream: lineView(assignment, owner),
    tell_user: `已开工作线「${assignment.responsibility}」交给 ${owner.name}`
      + (words.length ? `，词：${words.join('、')}` : '') + (branches.length ? `；分支：${branches.join('、')}` : '') };
}

// A line's word terms and, apart, its branches (without the branch: prefix).
function byKind(terms) {
  const branches = terms.filter(term => isBranchTerm(identityKey(term)));
  return { words: terms.filter(term => !branches.includes(term)),
    branches: branches.map(term => term.slice(term.indexOf(':') + 1)) };
}

// Whether this is the lead's own change to a line it opened: it then applies
// in one call (no preview digest, no user yes) and stays the host's, like the
// line's opening. A line the person opened or confirmed is not.
export async function isLeadsOwnLine(application, task, current) {
  if (current.source !== 'host' || !task.projectAgentId) return false;
  const lead = await projectLead(application, application.config.personal.spaceId, current.projectId);
  return Boolean(lead) && task.projectAgentId === lead && current.leadAgentId !== lead;
}

// The console's lines: the person's clicks, or an FLA acting for them (call,
// from agent-delegation-gate.js), which must be that project's lead.
export async function openWorkstreamInConsole(application, body, call) {
  const projectId = requiredString(body.personalProjectId, 'personalProjectId', ID_LIMIT);
  if (call) await asLeadOf(application, projectId, call.actor.agentId);
  const owner = await lineOwner(application, projectId, requiredString(body.leadAgentId, 'leadAgentId', ID_LIMIT));
  const { assignment } = standingAssignmentsOf(application).open(lineRegistration(application, { projectId, owner,
    terms: body.terms, responsibility: body.responsibility, ...consoleSource(call) }));
  return { status: 'created', workstream: lineView(assignment, owner) };
}

export async function mergeWorkstreamsInConsole(application, assignmentId, body, call) {
  const port = standingAssignmentsOf(application);
  const source = lineOf(port, assignmentId);
  if (call) await asLeadOf(application, source.projectId, call.actor.agentId);
  return port.merge(source.assignmentId, requiredString(body.into, 'into', ID_LIMIT), { ...consoleSource(call),
    expectedRevision: body.expectedRevision, targetRevision: body.targetRevision });
}

export async function splitWorkstreamInConsole(application, assignmentId, body, call) {
  const port = standingAssignmentsOf(application);
  const source = lineOf(port, assignmentId);
  if (call) await asLeadOf(application, source.projectId, call.actor.agentId);
  const owner = await lineOwner(application, source.projectId, requiredString(body.leadAgentId, 'leadAgentId', ID_LIMIT));
  return port.split(source.assignmentId, { terms: body.terms, extraTerms: body.extraTerms, leadAgentId: owner.agentId,
    responsibility: requiredString(body.responsibility, 'responsibility', RESPONSIBILITY_LIMIT) },
  { ...consoleSource(call), expectedRevision: body.expectedRevision });
}

// Who a console change is from, and that an FLA acting for the person may
// change a line only as that project's lead.
export async function consoleCorrectionSource(application, current, call) {
  if (!call) return consoleSource(null);
  await asLeadOf(application, current.projectId, call.actor.agentId);
  return consoleSource(call);
}

function consoleSource(call) {
  return call ? { source: 'host', sourceConversationId: call.actor.sessionId ?? null }
    : { source: 'user', sourceConversationId: null };
}

async function asLeadOf(application, projectId, agentId) {
  if (!projectId) {
    throw refusal('workstream_project_required', 'This task belongs to no project, so it has no workstreams. '
      + 'Nothing was saved.', 422);
  }
  const lead = await projectLead(application, application.config.personal.spaceId, projectId);
  if (!lead) {
    throw refusal('workstream_lead_required', `Project ${projectId} has no active lead to divide its work. `
      + 'Nothing was saved.', 409);
  }
  if (agentId !== lead) {
    throw refusal('workstream_lead_only', 'Only this project\'s lead divides its work into workstreams. Nothing was '
      + 'saved; ask the lead, or have the person do it on the project page.', 403);
  }
  return { projectId, lead };
}

// A line's owner: an active member of the project other than its lead.
async function lineOwner(application, projectId, agentId) {
  const team = await loadProjectTeam(application, application.config.personal.spaceId, projectId);
  if (team.lead?.agentId === agentId) {
    throw refusal('workstream_owner_is_lead', 'A workstream separates a line of work from the lead; name a member of '
      + 'this project. To give a line back to the lead, end it. Nothing was saved.', 422);
  }
  const member = activeTeamAgent(team, agentId);
  if (member && !member.peerRole) return { agentId, name: member.name };
  throw refusal('workstream_owner_not_in_project', `${agentId} is not an active member of this project. Add it to `
    + 'the project first (create_project_agent_assignment), or have Bole recruit one. Nothing was saved.', 422);
}

function lineOf(port, assignmentId) {
  const line = port.get(requiredString(assignmentId, 'assignmentId', ID_LIMIT));
  if (line) return line;
  throw new ApplicationError(ApplicationErrorCode.NOT_FOUND, 'No standing assignment has this ID.', { status: 404 });
}

function lineRegistration(application, { projectId, owner, terms, responsibility, source, sourceConversationId }) {
  return { personalSpaceId: application.config.personal.spaceId, projectId, leadAgentId: owner.agentId, terms,
    responsibility: requiredString(responsibility, 'responsibility', RESPONSIBILITY_LIMIT), source,
    sourceConversationId };
}

function view(workstream, terms, owner) {
  const { words, branches } = byKind(terms);
  return { workstream, terms: words, ...(branches.length ? { branches } : {}), owner_agent_id: owner.agentId,
    owner_name: owner.name };
}

function lineView(assignment, owner) {
  return { ...view(assignment.responsibility, assignment.terms, owner), assignment_id: assignment.assignmentId,
    revision: assignment.revision };
}

function refusal(code, message, status) {
  return new ApplicationError(code, message, { status });
}
