import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError, ApplicationErrorCode, isControlledError } from '../app/application-error.js';
import { identityKey } from '../text/name-identity.js';
import { requiredString } from '../validation/values.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';
import { createProjectNamed, projectByName } from './task-entry-project-mention.js';

// "From now on, this kind of work goes to that project": the person's own
// decision, said in a conversation (rec#29 D-41 D1). preview resolves what
// would happen and writes nothing; the host asks the person once with its one
// sentence. confirm, given the preview's digest, recomputes the plan and
// applies it only while it is unchanged: it reuses the project of that name
// or creates it, has AR staff the project's lead with the person's
// responsibility when it has none (D4), and registers the terms as the
// person's (source user). Global preferences are referenced by ID only (D5).
// Neither step starts or does the work itself.
//
// Confirming a plan that is already in place changes nothing, so a repeated
// confirm never creates a second project or hire.

const PROJECT_NAME_LIMIT = 80;
const USER_WORDS_LIMIT = 600;
const DIGEST_LIMIT = 64;
const TOKEN_LIMIT = 256;
// A standing rule in the person's own words, with the markers Tonborg's
// standing-rule criterion names (judgment/review-prompt.js). A request for
// this time only is done in its task, not registered.
const STANDING_INTENT = /(?:from now on|going forward|from here on|in (?:the )?future|always|every time|whenever|以后|今后|往后|从现在起|从今往后|从此|一律|一直|每次|长期|默认)/iu;
const NOT_EXECUTED = 'Registered and assigned, NOT executed: no task was started or done. Later tasks that mention these terms go to this lead.';
const ASK_ONCE = 'Nothing was saved. Ask the user once with restatement, in their language; only after a clear yes call confirm with the same input and this confirmationDigest.';

export async function registerStandingAssignment(application, input = {}) {
  if (!application.standingAssignments) {
    throw new ApplicationError('standing_assignments_unavailable', 'Standing assignments need a local FULI installation',
      { status: 503 });
  }
  if (input.action !== 'preview' && input.action !== 'confirm') throw invalid('action must be preview or confirm');
  const plan = await currentPlan(application, input);
  return input.action === 'preview' ? previewResult(plan) : confirm(application, plan, input);
}

async function currentPlan(application, input) {
  const userWords = requiredString(input.userWords, 'userWords', USER_WORDS_LIMIT);
  if (!STANDING_INTENT.test(userWords)) {
    throw new ApplicationError('standing_assignment_one_off', 'The user\'s words state no standing rule (from now on, '
      + '以后, always). Do a one-off request in this task; nothing was registered.', { status: 422 });
  }
  const task = await application.taskContextRegistry.context(
    requiredString(input.taskContextToken, 'taskContextToken', TOKEN_LIMIT), input.sourceApplication ?? 'other');
  if (task.activityOrigin || hostInternalActivity(application, { sessionId: task.sessionId })) {
    throw new ApplicationError('standing_assignment_internal_activity', 'Internal Agent activity cannot register a '
      + 'standing assignment; only the person can, in their own conversation. Nothing was saved.', { status: 403 });
  }
  const spaceId = application.config.personal.spaceId;
  const name = requiredString(input.projectName, 'projectName', PROJECT_NAME_LIMIT);
  const named = await projectByName(application, name);
  if (named?.ambiguous) {
    throw new ApplicationError('standing_assignment_project_ambiguous', `${named.candidateCount} projects are named `
      + `"${name}"; ask the user which one they mean. Nothing was saved.`, { status: 409 });
  }
  const projectId = named?.personalProjectId ?? null;
  const leadAgentId = projectId ? await projectLead(application, spaceId, projectId) : null;
  const registration = application.standingAssignments.preview({ personalSpaceId: spaceId, projectId, leadAgentId,
    terms: input.terms, responsibility: input.responsibility, preferenceIds: input.preferenceIds, source: 'user',
    sourceConversationId: task.sessionId });
  const current = registration.assignment;
  return {
    personalSpaceId: spaceId, sourceConversationId: task.sessionId, userWords,
    project: { action: projectId ? 'reuse' : 'create', projectId, name },
    lead: { action: leadAgentId ? 'reuse' : 'hire', agentId: leadAgentId,
      name: leadAgentId ? await leadName(application, spaceId, projectId, leadAgentId) : null },
    terms: registration.terms, preferenceIds: registration.preferenceIds,
    // An existing assignment keeps the responsibility it was registered with.
    responsibility: current?.responsibility ?? registration.responsibility,
    assignment: { action: registration.status, assignmentId: current?.assignmentId ?? null,
      revision: current?.revision ?? null }
  };
}

function previewResult(plan) {
  if (inPlace(plan)) {
    return { status: 'already_registered', plan: planView(plan), executed: false,
      restatement: `${quoted(plan.terms)} already go to project "${plan.project.name}" (lead "${plan.lead.name}"); `
        + 'there is nothing to register.' };
  }
  return { status: 'preview', plan: planView(plan), restatement: restatement(plan),
    confirmationDigest: contentHash(plan), executed: false, guidance: ASK_ONCE };
}

// Other requests run while this one awaits the Provider, so the project's
// lead and the terms are checked again just before the writes that depend on
// them. Every failure after the first Provider write goes through
// partiallyApplied: what was written stays (another request may already use
// it, so nothing is rolled back), and the error names it, with the failure
// itself as its cause. Before any write the failure stands as it is.
async function confirm(application, plan, input) {
  if (inPlace(plan)) return confirmed('unchanged', plan, existingState(plan), null);
  if (requiredString(input.confirmationDigest, 'confirmationDigest', DIGEST_LIMIT) !== contentHash(plan)) {
    throw new ApplicationError('standing_assignment_plan_changed', 'The plan is not the one previewed: it changed '
      + 'since, or the digest belongs to other input. Nothing was saved; preview again and ask the user again.',
    { status: 409 });
  }
  const state = existingState(plan);
  try {
    // A term another request took since the plan was read refuses before anything is written.
    application.standingAssignments.preview(registrationOf(plan, state.projectId, state.leadAgentId));
    if (!state.projectId) {
      // Until the Provider answers, whether the project exists is unknown.
      Object.assign(state, { attempted: true, project: 'unknown' });
      const created = await createProjectNamed(application, plan.project.name, plan.responsibility);
      Object.assign(state, { projectId: created.personalProjectId,
        project: created.basis === 'created_from_prompt' ? 'created' : 'existing' });
    }
    if (!state.leadAgentId) await hireLead(application, plan, state, input.sourceApplication ?? 'other');
    const lead = await projectLead(application, plan.personalSpaceId, state.projectId);
    if (lead !== state.leadAgentId) throw leadChanged(state, lead);
    const { assignment } = application.standingAssignments.register(
      registrationOf(plan, state.projectId, state.leadAgentId));
    return confirmed('registered', plan, state, assignment);
  } catch (error) {
    throw state.attempted ? partiallyApplied(application, plan, state, error) : unwritten(error);
  }
}

// AR hires the lead through the ordinary default-lead staffing, with the
// person's responsibility leading the lead's own (D4). A lead another request
// hired meanwhile is not the lead this plan was confirmed for.
async function hireLead(application, plan, state, sourceApplication) {
  Object.assign(state, { attempted: true, lead: 'unknown' });
  const staffed = await application.personal.staffDefaultProjectLead({ personal_space_id: plan.personalSpaceId,
    personal_project_id: state.projectId, source_application: sourceApplication, responsibility: plan.responsibility });
  if (staffed?.agent?.agent_id) {
    Object.assign(state, { lead: 'hired', leadAgentId: staffed.agent.agent_id });
    return;
  }
  state.lead = null;
  const lead = await projectLead(application, plan.personalSpaceId, state.projectId);
  if (lead) throw leadChanged(state, lead);
  throw refusal('standing_assignment_lead_unavailable',
    `AR could not staff the project's lead (${staffed?.reason ?? 'unavailable'}).`, 503);
}

// What exists before confirm writes: the plan's project and lead, if any.
function existingState(plan) {
  return { attempted: false, projectId: plan.project.projectId, project: plan.project.projectId ? 'existing' : null,
    leadAgentId: plan.lead.agentId, lead: plan.lead.agentId ? 'existing' : null };
}

function registrationOf(plan, projectId, leadAgentId) {
  return { personalSpaceId: plan.personalSpaceId, projectId, leadAgentId, terms: plan.terms,
    responsibility: plan.responsibility, preferenceIds: plan.preferenceIds, source: 'user',
    sourceConversationId: plan.sourceConversationId };
}

function leadChanged(state, lead) {
  return refusal('standing_assignment_plan_changed', 'The project\'s lead changed while confirming: it is now '
    + `${lead ?? 'nobody'}, not ${state.leadAgentId ?? 'a lead hired for this plan'}.`, 409);
}

// confirm's own refusals: a reason that claims nothing about what was saved,
// completed by unwritten or partiallyApplied.
function refusal(code, reason, status) {
  return Object.assign(new ApplicationError(code, reason, { status }), { refusal: true });
}

function unwritten(error) {
  if (!error?.refusal) return error;
  return new ApplicationError(error.code, `${error.message} The terms were NOT registered. Nothing was saved; preview `
    + 'again and ask the user again.', { status: error.status });
}

// The written state leads; the original failure is kept as cause. A
// diagnostic that fails only leaves its detail out.
function partiallyApplied(application, plan, state, error) {
  const controlled = isControlledError(error);
  const cause = { code: typeof error?.code === 'string' ? error.code : 'internal_error',
    message: controlled ? error.message : 'unexpected error' };
  const detail = (cause.code === 'standing_assignment_term_taken' ? takenTermDetail(application, plan, state)
    : cause.message)?.replace(/\.$/, '');
  const failed = new ApplicationError('standing_assignment_partially_applied', `Partly applied: `
    + `${writtenSoFar(plan, state)}; what was written is kept. The terms were NOT registered (${cause.code}`
    + `${detail ? `: ${detail}` : ''}). Preview again and ask the user again: it reuses the project and lead that exist `
    + 'now.', { status: error?.status ?? 500 });
  return Object.assign(failed, { cause, written: { project: state.project, projectId: state.projectId,
    projectName: plan.project.name, lead: state.lead, leadAgentId: state.leadAgentId } });
}

function takenTermDetail(application, plan, state) {
  try {
    for (const assignment of application.standingAssignments.list(plan.personalSpaceId)) {
      if (assignment.projectId === state.projectId && assignment.leadAgentId === state.leadAgentId) continue;
      const keys = new Set(assignment.terms.map(identityKey));
      const term = plan.terms.find(value => keys.has(identityKey(value)));
      if (term) {
        return `"${term}" already names the standing assignment of project ${assignment.projectId} `
          + `(lead ${assignment.leadAgentId})`;
      }
    }
  } catch {
    // Best effort: the failure and the written state are reported without it.
  }
  return null;
}

function writtenSoFar(plan, { project, projectId, lead, leadAgentId }) {
  const projectPart = project === 'unknown' ? `whether project "${plan.project.name}" was created is unknown`
    : `project "${plan.project.name}" (${projectId}) ${project === 'created' ? 'was created' : 'already existed'}`;
  const leadPart = { hired: `AR hired its lead ${leadAgentId}`, existing: `its lead ${leadAgentId} already existed`,
    unknown: 'whether AR hired its lead is unknown' }[lead];
  return leadPart ? `${projectPart}, and ${leadPart}` : projectPart;
}

function confirmed(status, plan, { projectId, project, leadAgentId, lead }, assignment) {
  return { status, executed: false, notice: NOT_EXECUTED,
    project: { projectId, name: plan.project.name, created: project === 'created' },
    lead: { agentId: leadAgentId, hired: lead === 'hired' },
    terms: plan.terms, ...(assignment ? { assignment } : {}) };
}

// The project, its lead and every term already name one active assignment.
function inPlace(plan) {
  return plan.project.action === 'reuse' && plan.lead.action === 'reuse' && plan.assignment.action === 'unchanged';
}

function restatement(plan) {
  const project = `${plan.project.action === 'create' ? 'create' : 'reuse'} project "${plan.project.name}"`;
  const lead = plan.lead.action === 'hire' ? 'have AR hire its lead' : `keep its lead "${plan.lead.name}"`;
  return `FULI will ${project}, ${lead} for "${plan.responsibility}", and send later tasks that mention `
    + `${quoted(plan.terms)} there; nothing is done now.`;
}

function planView({ project, lead, terms, responsibility, preferenceIds, assignment }) {
  return { project, lead, terms, responsibility, preferenceIds, assignment };
}

async function projectLead(application, spaceId, projectId) {
  return (await application.personal.getProjectAgentCoordinationPolicy(spaceId, projectId))?.team_lead_agent_id ?? null;
}

async function leadName(application, spaceId, projectId, agentId) {
  return (await application.personal.getProjectAgent(spaceId, projectId, agentId))?.profile?.name ?? agentId;
}

const quoted = terms => terms.map(term => `"${term}"`).join(', ');

function invalid(message) {
  return new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
