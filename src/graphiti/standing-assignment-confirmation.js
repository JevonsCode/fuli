import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';
import { hostInternalActivity } from './task-entry-activity-origin.js';
import { projectByName } from './task-entry-project-mention.js';

// What every change the person makes to a standing assignment in a
// conversation shares (rec#29 D-41: registering it, F5: correcting or ending
// it): only the person's own conversation may ask for it, preview resolves a
// plan and writes nothing, and confirm applies the plan only while it still
// hashes to the digest the person was asked about.

const DIGEST_LIMIT = 64;
const TOKEN_LIMIT = 256;
const ASK_ONCE = 'Nothing was saved. Ask the user once with restatement, in their language; only after a clear yes call confirm with the same input and this confirmationDigest.';

export function standingAssignmentsOf(application) {
  if (!application.standingAssignments) {
    throw new ApplicationError('standing_assignments_unavailable', 'Standing assignments need a local FULI installation',
      { status: 503 });
  }
  return application.standingAssignments;
}

// The calling task's conversation; internal Agent activity is refused.
export async function personsConversation(application, input) {
  const task = await application.taskContextRegistry.context(
    requiredString(input.taskContextToken, 'taskContextToken', TOKEN_LIMIT), input.sourceApplication ?? 'other');
  if (task.activityOrigin || hostInternalActivity(application, { sessionId: task.sessionId })) {
    throw new ApplicationError('standing_assignment_internal_activity', 'Internal Agent activity cannot register or '
      + 'change a standing assignment; only the person can, in their own conversation. Nothing was saved.', { status: 403 });
  }
  return task;
}

// The one nameable project of this name, or null when there is none.
export async function projectNamed(application, name) {
  const named = await projectByName(application, name);
  if (named?.ambiguous) {
    throw new ApplicationError('standing_assignment_project_ambiguous', `${named.candidateCount} projects are named `
      + `"${name}"; ask the user which one they mean. Nothing was saved.`, { status: 409 });
  }
  return named?.personalProjectId ?? null;
}

export async function projectLead(application, spaceId, projectId) {
  return (await application.personal.getProjectAgentCoordinationPolicy(spaceId, projectId))?.team_lead_agent_id ?? null;
}

export async function leadName(application, spaceId, projectId, agentId) {
  return (await application.personal.getProjectAgent(spaceId, projectId, agentId))?.profile?.name ?? agentId;
}

export function previewOf(plan, view, restatement) {
  return { status: 'preview', plan: view, restatement, confirmationDigest: contentHash(plan), executed: false,
    guidance: ASK_ONCE };
}

export function assertPreviewed(input, plan) {
  if (requiredString(input.confirmationDigest, 'confirmationDigest', DIGEST_LIMIT) === contentHash(plan)) return;
  throw new ApplicationError('standing_assignment_plan_changed', 'The plan is not the one previewed: it changed '
    + 'since, or the digest belongs to other input. Nothing was saved; preview again and ask the user again.',
  { status: 409 });
}

export const quoted = terms => terms.map(term => `"${term}"`).join(', ');
