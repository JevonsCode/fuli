import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
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

async function confirm(application, plan, input) {
  if (inPlace(plan)) return confirmed('unchanged', plan, plan.project.projectId, plan.lead.agentId, null);
  if (requiredString(input.confirmationDigest, 'confirmationDigest', DIGEST_LIMIT) !== contentHash(plan)) {
    throw new ApplicationError('standing_assignment_plan_changed', 'The plan is not the one previewed: it changed '
      + 'since, or the digest belongs to other input. Nothing was saved; preview again and ask the user again.',
    { status: 409 });
  }
  const projectId = plan.project.projectId
    ?? (await createProjectNamed(application, plan.project.name, plan.responsibility)).personalProjectId;
  const leadAgentId = plan.lead.agentId
    ?? await hireLead(application, plan, projectId, input.sourceApplication ?? 'other');
  const { assignment } = application.standingAssignments.register({ personalSpaceId: plan.personalSpaceId,
    projectId, leadAgentId, terms: plan.terms, responsibility: plan.responsibility,
    preferenceIds: plan.preferenceIds, source: 'user', sourceConversationId: plan.sourceConversationId });
  return confirmed('registered', plan, projectId, leadAgentId, assignment);
}

// AR hires the lead through the ordinary default-lead staffing, with the
// person's responsibility leading the lead's own (D4).
async function hireLead(application, plan, projectId, sourceApplication) {
  const staffed = await application.personal.staffDefaultProjectLead({ personal_space_id: plan.personalSpaceId,
    personal_project_id: projectId, source_application: sourceApplication, responsibility: plan.responsibility });
  // A lead another task hired meanwhile is the project's lead all the same.
  const agentId = staffed?.agent?.agent_id ?? await projectLead(application, plan.personalSpaceId, projectId);
  if (!agentId) {
    throw new ApplicationError('standing_assignment_lead_unavailable', `Project "${plan.project.name}" exists, but `
      + `AR could not staff its lead (${staffed?.reason ?? 'unavailable'}). Nothing was registered; preview again later.`,
    { status: 503 });
  }
  return agentId;
}

function confirmed(status, plan, projectId, leadAgentId, assignment) {
  return { status, executed: false, notice: NOT_EXECUTED,
    project: { projectId, name: plan.project.name, created: status === 'registered' && plan.project.action === 'create' },
    lead: { agentId: leadAgentId, hired: status === 'registered' && plan.lead.action === 'hire' },
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
