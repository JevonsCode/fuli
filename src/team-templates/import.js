import { contentHash } from '../../packages/roundtable/src/canonical-json.js';

import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { singleLineExcerpt } from '../text/single-line.js';
import { slugText } from './schema.js';

// Applies a confirmed plan. Every write names a deterministic identity or an
// idempotency key, so a retry after a partial failure resumes instead of
// duplicating: the same role creates one Agent and one assignment. Nothing
// here confirms a workflow, writes accepted memory, or registers a standing
// line: a workflow proposal still waits for the person, and the acceptance
// checks and recurring blueprints stay drafts in the target's own receipt.
//
// Writes are individually durable, not one transaction. A failure after some
// writes returns the part that was applied and says the call is retryable,
// never a rollback that would undo work the person can already see.

const AGENT_ID_MAX = 256;
const IDEMPOTENCY_MAX = 256;
// A check's text is clipped for the answer; its full text stays in the
// target's own draft receipt.
const CHECK_TEXT = 300;

// A workflow this template proposed, so a later preview recognises its own
// work. The target project, role and workflow name give a stable, readable
// source; a short digest keeps two names the same slug apart. It belongs to
// the target project, never to the source team.
export function workflowSourceOf(personalProjectId, roleKey, name) {
  const slug = slugText(name, 40) || 'workflow';
  const project = contentHash(personalProjectId).slice(0, 8);
  return `team-template:${project}:${roleKey}:${slug}-${contentHash([roleKey, name]).slice(0, 8)}`;
}

export async function importProjectTeam(application, plan, input, attribution = {}) {
  if (plan.status !== 'ready') {
    throw new ApplicationError('team_template_not_ready',
      'This plan reported conflicts, so nothing was written. Resolve them and preview again.', { status: 409 });
  }
  const personalSpaceId = input.personalSpaceId;
  const personalProjectId = requiredProjectId(input.personalProjectId);
  const applied = {
    agents: { created: [], reused: [] },
    assignments: { created: [], reused: [] },
    policy: 'unchanged',
    workflows: { proposed: [], kept: [], unchanged: [] },
    recurringJobs: { drafted: [], kept: [], unchanged: [] },
    templateDraft: 'none'
  };

  try {
    for (const role of plan.roles) {
      if (role.action === 'create') {
        await createRoleAgent(application, personalSpaceId, personalProjectId, role);
        applied.agents.created.push(role.agentId);
      } else {
        applied.agents.reused.push(role.agentId);
      }
      if (role.assignment === 'create') {
        await assignRole(application, personalSpaceId, personalProjectId, role, attribution);
        applied.assignments.created.push(role.agentId);
      } else {
        applied.assignments.reused.push(role.agentId);
      }
    }

    if (plan.policy?.action === 'update') {
      await application.updateProjectAgentCoordinationPolicy(policyUpdateOf(personalSpaceId, personalProjectId, plan.policy));
      applied.policy = 'updated';
    }

    for (const workflow of plan.workflows) {
      if (workflow.action === 'kept') {
        applied.workflows.kept.push(workflow.name);
        continue;
      }
      if (workflow.action === 'unchanged') {
        applied.workflows.unchanged.push(workflow.name);
        continue;
      }
      await application.agentWorkflows.propose(
        { personalSpaceId, agentId: workflow.agentId, personalProjectId },
        proposalOf(workflow)
      );
      applied.workflows.proposed.push(workflow.name);
    }

    for (const job of plan.recurringJobs) {
      if (job.action === 'kept') {
        applied.recurringJobs.kept.push(job.responsibility);
        continue;
      }
      if (job.action === 'unchanged') {
        applied.recurringJobs.unchanged.push(job.responsibility);
        continue;
      }
      // A blueprint, never an active standing assignment: importing a team
      // describes a line of work, it does not start routing new jobs to it.
      applied.recurringJobs.drafted.push(job.responsibility);
    }

    applied.templateDraft = keepTemplateDraft(application, personalSpaceId, personalProjectId, plan);

    return {
      status: 'imported',
      templateId: plan.templateId,
      personalProjectId,
      confirmationDigest: plan.confirmationDigest,
      lead: plan.lead,
      relationships: plan.relationships,
      policy: plan.policy,
      acceptance: plan.acceptance.map(check => ({ ...check, text: singleLineExcerpt(check.text, CHECK_TEXT) })),
      templateDraft: plan.templateDraft,
      applied,
      counts: countsOf(applied),
      next: 'The team is ready. The person confirms each proposed workflow in the FULI console. '
        + 'The imported acceptance checks and recurring blueprints are kept as drafts in this project: '
        + 'read them after a restart with read_project_team_template (get_project_team names the draft). '
        + 'They neither run nor route work until the target person enables them.'
    };
  } catch (error) {
    return {
      status: 'partial',
      retryable: true,
      templateId: plan.templateId,
      personalProjectId,
      confirmationDigest: plan.confirmationDigest,
      applied,
      counts: countsOf(applied),
      failure: {
        code: typeof error?.code === 'string' ? error.code : 'team_template_import_failed',
        message: error?.message ?? String(error)
      },
      next: 'Part of the team was saved. Fix the reported failure and call import_project_team_template again '
        + 'with the same inputs; every saved part is reused, not duplicated.'
    };
  }
}

async function createRoleAgent(application, personalSpaceId, personalProjectId, role) {
  const profile = {
    name: role.occupation.role,
    responsibility: role.responsibility,
    capabilities: role.capabilities,
    workKinds: role.workKinds,
    agentType: role.agentType,
    status: 'active'
  };
  await application.upsertProjectAgent({
    personalSpaceId,
    personalProjectId,
    agentId: role.agentId,
    profile,
    occupation: { role: role.occupation.role, tags: role.occupation.tags }
  });
}

async function assignRole(application, personalSpaceId, personalProjectId, role, attribution) {
  await application.createProjectAgentAssignment({
    personalSpaceId,
    personalProjectId,
    agentId: role.agentId,
    idempotencyKey: assignmentIdempotencyKey(personalProjectId, role.roleKey),
    responsibility: role.responsibility,
    workKinds: role.workKinds,
    capabilities: role.capabilities,
    reason: `Import the project team template role ${role.roleKey}`,
    sourceApplication: attribution.sourceApplication ?? null,
    sourceSessionId: attribution.sourceSessionId ?? null
  });
}

function assignmentIdempotencyKey(personalProjectId, roleKey) {
  const readable = `team-template:${personalProjectId}:${roleKey}`;
  if (readable.length <= IDEMPOTENCY_MAX) return readable;
  return `team-template:${contentHash([personalProjectId, roleKey]).slice(0, 48)}`;
}

// The target's own switches stay: a field the plan carries is sent back as it
// was, and a field it does not carry is left for the Provider to keep.
function policyUpdateOf(personalSpaceId, personalProjectId, policy) {
  const update = {
    personalSpaceId,
    personalProjectId,
    teamLeadAgentId: policy.teamLeadAgentId,
    teamMemberAgentIds: policy.teamMemberAgentIds,
    subTeams: policy.subTeams.map(group => ({
      id: group.id,
      name: group.name,
      leadAgentId: group.leadAgentId,
      memberAgentIds: group.memberAgentIds
    })),
    subTeamSuggestionThreshold: policy.subTeamSuggestionThreshold,
    expectedUpdatedAt: policy.expectedUpdatedAt
  };
  for (const [key, value] of Object.entries({
    askBeforeRecruitment: policy.askBeforeRecruitment,
    autoReusePreviousAgent: policy.autoReusePreviousAgent,
    autoGrowTeam: policy.autoGrowTeam
  })) {
    if (value !== undefined) update[key] = value;
  }
  return update;
}

function proposalOf(workflow) {
  const transfer = Boolean(workflow.lesson);
  return {
    ...(workflow.workflowId ? { workflowId: workflow.workflowId } : {}),
    name: workflow.name,
    purpose: workflow.purpose,
    steps: workflow.steps,
    source: workflow.source,
    ...(workflow.workMap ? { workMap: workflow.workMap } : {}),
    // A learned workflow travels as what to do when, its boundary and the
    // checks that showed it worked. It waits for this project's person; the
    // source delivery and the person's old words never travel.
    ...(transfer ? { transfer: true, lesson: {
      trigger: workflow.lesson.trigger,
      scope: workflow.lesson.scope,
      acceptanceEvidence: workflow.lesson.checks ?? workflow.lesson.acceptanceEvidence ?? []
    } } : {})
  };
}

// The one durable copy of the checks and recurring blueprints. The first
// import owns it; a retry or a newer source never rewrites it.
function keepTemplateDraft(application, personalSpaceId, personalProjectId, plan) {
  if (!plan.templateDraft || plan.templateDraft.action === 'none') return 'none';
  if (!application.teamTemplateReceipts?.keep) return 'unavailable';
  const saved = application.teamTemplateReceipts.keep({
    personalSpaceId,
    personalProjectId,
    templateId: plan.templateId,
    importedAt: new Date().toISOString(),
    // The template lead's portable role when it filled the project's own
    // bootstrap seat; the Agent itself keeps its profile and access.
    leadSeat: plan.leadDraft ?? null,
    acceptance: plan.acceptance.map(({ kind, text, occupation }) => ({ kind, text, occupation })),
    recurringBlueprints: plan.recurringJobs.map(({ roleKey, responsibility, terms }) => ({ roleKey, responsibility, terms }))
  });
  if (!saved) return 'unavailable';
  if (plan.templateDraft.action !== 'draft') return plan.templateDraft.action;
  return saved.templateId === plan.templateId ? 'drafted' : 'kept';
}

function countsOf(applied) {
  return {
    agentsCreated: applied.agents.created.length,
    agentsReused: applied.agents.reused.length,
    assignmentsCreated: applied.assignments.created.length,
    assignmentsReused: applied.assignments.reused.length,
    policyChanged: applied.policy === 'updated',
    workflowsProposed: applied.workflows.proposed.length,
    workflowsKept: applied.workflows.kept.length,
    recurringJobsDrafted: applied.recurringJobs.drafted.length,
    recurringJobsUnchanged: applied.recurringJobs.unchanged.length,
    recurringJobsKept: applied.recurringJobs.kept.length
  };
}

function requiredProjectId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > AGENT_ID_MAX) {
    throw new InvalidInputError('personalProjectId is required');
  }
  return value;
}
