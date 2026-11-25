import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { requiredString } from '../validation/values.js';
import { singleLineExcerpt } from '../text/single-line.js';
import { workflowSourceOf } from './import.js';
import { bootstrapLeadProvenance, leadIsWorking } from './lead-seat.js';
import { portableTemplate } from './schema.js';

// Plans an import against one explicitly selected project. A plan is a read:
// it maps every template role to an existing or deterministic Agent, checks
// the target's current lead, members and sub-teams, and asks each port what it
// would do. Every foreseeable conflict is returned before anything is written.
// An existing role, workflow or imported draft is never rewritten: a reimport
// after the team changed locally reports it as kept.

const AGENT_ID_MAX = 256;
const DIGEST_LENGTH = 64;
const PREVIEW_TEXT = 300;

export async function planTeamTemplateImport(application, input) {
  const personalSpaceId = input.personalSpaceId;
  const personalProjectId = requiredString(input.personalProjectId, 'personalProjectId', AGENT_ID_MAX);
  const { template, redactions } = portableTemplate(input.template);
  const roleAgentIds = roleAgentIdsOf(input.roleAgentIds, template);
  const confirmationDigest = confirmationDigestOf({ templateId: template.templateId, personalProjectId, roleAgentIds });

  const conflicts = [];
  const project = await projectOrNull(application, personalSpaceId, personalProjectId);
  if (!project) {
    return conflictPlan({ template, personalProjectId, confirmationDigest, conflicts: [{
      code: 'team_template_project_not_found',
      message: 'No authorized project has this personalProjectId. Choose an existing project of the active space.'
    }] });
  }

  const policy = await application.personal.getProjectAgentCoordinationPolicy(personalSpaceId, personalProjectId);
  const receipt = receiptOf(application, personalSpaceId, personalProjectId);
  const leadRole = template.roles.find(role => role.roleKey === template.relationships.leadRoleKey) ?? null;
  // The normal entry staffs a bootstrap lead before the person can preview, so
  // an untouched automatic lead fills the template's lead seat instead of
  // blocking the import. Anything a person set or changed is not adopted.
  const adoptedLead = await planBootstrapLead({ application, personalSpaceId, personalProjectId, policy,
    leadRole, template, roleAgentIds, receipt });

  const roles = [];
  for (const role of template.roles) {
    if (adoptedLead && role.roleKey === adoptedLead.roleKey) {
      // The bootstrap lead keeps its own identity, profile, occupation and
      // access. The template lead role only occupies its seat: no Agent or
      // assignment is written, and the project's own lead responsibility stays
      // exactly as the normal entry staffed it.
      roles.push({
        roleKey: role.roleKey,
        agentId: adoptedLead.agentId,
        action: 'reuse',
        assignment: 'reuse',
        responsibility: role.responsibility,
        occupation: role.occupation,
        capabilities: role.capabilities,
        workKinds: role.workKinds,
        agentType: role.agentType
      });
      continue;
    }
    const mappedId = roleAgentIds[role.roleKey] ?? null;
    const agentId = mappedId ?? targetAgentIdFor(personalProjectId, role.roleKey);
    const existing = await agentOrNull(application, personalSpaceId, agentId);
    if (mappedId && !existing) {
      conflicts.push({ code: 'team_template_role_agent_not_found', roleKey: role.roleKey,
        message: `roleAgentIds maps ${role.roleKey} to ${mappedId}, but no Agent has that ID in this space.` });
      continue;
    }
    if (existing) assertReusableAgent(existing, role, conflicts);
    roles.push({
      roleKey: role.roleKey,
      agentId,
      action: existing ? (mappedId ? 'mapped' : 'reuse') : 'create',
      // A retry after a partial failure may have saved the Agent but not its
      // assignment, so the assignment is read rather than inferred.
      assignment: existing && hasTargetAssignment(existing, personalProjectId) ? 'reuse' : 'create',
      responsibility: role.responsibility,
      occupation: role.occupation,
      capabilities: role.capabilities,
      workKinds: role.workKinds,
      agentType: role.agentType
    });
  }

  const lead = roles.find(role => role.roleKey === template.relationships.leadRoleKey) ?? null;
  const policyPlan = planPolicy({ template, roles, lead, leadSeat: adoptedLead, policy, conflicts });
  const workflows = await planWorkflows(application, personalSpaceId, personalProjectId, template, roles, conflicts);
  // The template lead's portable role and responsibility cannot be written
  // onto the bootstrap Agent without replacing the project's own settings, so
  // they are kept in the target's draft receipt and named by preview/read.
  const leadDraft = adoptedLead && leadRole ? {
    roleKey: leadRole.roleKey,
    agentId: adoptedLead.agentId,
    occupation: leadRole.occupation.role,
    responsibility: leadRole.responsibility
  } : null;
  if ((template.acceptance.length || template.recurringJobs.length || leadDraft)
      && !application.teamTemplateReceipts?.keep) {
    conflicts.push({ code: 'team_template_receipts_unavailable',
      message: 'This installation cannot keep the imported lead role, acceptance checks and recurring blueprints, '
        + 'so the team cannot be imported whole.' });
  }
  const draft = draftActionOf(receipt, template, leadDraft);
  const recurringJobs = planRecurringJobs(template, roles, lead, draft, conflicts);
  const acceptance = template.acceptance.map(check => ({
    kind: check.kind,
    text: check.text,
    occupation: check.occupation,
    roleKey: check.occupation ? roles.find(role => role.occupation.role === check.occupation)?.roleKey ?? null : null,
    status: 'draft',
    action: draft
  }));

  return {
    status: conflicts.length ? 'conflict' : 'ready',
    templateId: template.templateId,
    personalProjectId,
    confirmationDigest,
    redacted: redactions,
    lead: lead ? {
      roleKey: lead.roleKey,
      agentId: lead.agentId,
      action: lead.action === 'create' ? 'create' : 'reuse',
      ...(adoptedLead && leadRole ? {
        seat: 'adopted',
        occupation: adoptedLead.occupation,
        note: 'This project already had its automatically staffed lead. The import keeps that Agent, its '
          + 'occupation and its access, and puts the template lead role in its seat; the template lead\'s '
          + 'portable role and responsibility are kept as a target-owned draft.'
      } : {})
    } : null,
    roles,
    relationships: mappedRelationships(template, roles),
    policy: policyPlan,
    workflows,
    acceptance,
    recurringJobs,
    // The target keeps one draft receipt of the checks and recurring lines;
    // it never becomes an active standing assignment on import.
    templateDraft: {
      action: draft,
      templateId: template.templateId,
      storedTemplateId: receipt?.templateId ?? null,
      acceptance: acceptance.length,
      recurringJobs: recurringJobs.length,
      leadSeat: leadDraft ? { roleKey: leadDraft.roleKey, agentId: leadDraft.agentId } : null
    },
    // What the target's draft receipt keeps of the template lead's portable
    // role: the bootstrap Agent itself is never rewritten.
    leadDraft,
    conflicts,
    template
  };
}

function confirmationDigestOf({ templateId, personalProjectId, roleAgentIds }) {
  return contentHash({ templateId, personalProjectId, roleAgentIds: sortedMapping(roleAgentIds) });
}

export function assertConfirmed(input, plan) {
  const digest = input?.confirmationDigest;
  // The person's instruction already names the destination: a clear import
  // needs no second generic approval. A digest, when given, still has to match
  // the template, project and mapping it was previewed for.
  if (digest === undefined || digest === null || digest === '') return;
  if (typeof digest !== 'string' || digest.length !== DIGEST_LENGTH || digest !== plan.confirmationDigest) {
    throw new ApplicationError('team_template_confirmation_required',
      'This import was previewed for a different template, project or role mapping. '
      + 'Preview again and pass the confirmationDigest with the same inputs, or omit it. Nothing was written.', { status: 409 });
  }
}

// What the caller sees from a preview: the plan, without the template body or
// the per-workflow content import needs. Text is clipped for the answer only;
// import reads the full plan.
export function previewView(plan) {
  return {
    status: plan.status,
    templateId: plan.templateId,
    personalProjectId: plan.personalProjectId,
    confirmationDigest: plan.confirmationDigest,
    redacted: plan.redacted,
    lead: plan.lead,
    roles: plan.roles.map(role => ({ roleKey: role.roleKey, agentId: role.agentId, action: role.action,
      assignment: role.assignment, responsibility: singleLineExcerpt(role.responsibility, PREVIEW_TEXT) })),
    relationships: plan.relationships,
    policy: plan.policy,
    workflows: plan.workflows.map(workflow => ({ roleKey: workflow.roleKey, agentId: workflow.agentId,
      name: workflow.name, action: workflow.action, ...(workflow.reason ? { reason: workflow.reason } : {}) })),
    acceptance: plan.acceptance.map(check => ({ ...check, text: singleLineExcerpt(check.text, PREVIEW_TEXT) })),
    recurringJobs: plan.recurringJobs.map(job => ({ roleKey: job.roleKey, agentId: job.agentId,
      responsibility: job.responsibility, terms: job.terms, action: job.action })),
    templateDraft: plan.templateDraft,
    conflicts: plan.conflicts,
    ...(plan.status === 'ready'
      ? { next: 'If the person named this destination, call import_project_team_template with the same template or '
        + 'templateRef and personalProjectId. The digest is optional; pass it to bind this exact previewed plan.' }
      : { next: 'Resolve the reported conflicts; nothing was written.' })
  };
}

// The normal entry creates the project's bootstrap lead on the first task,
// before a person can preview. Adopt that untouched Agent for the template lead
// seat, except when the person explicitly mapped the lead role, the project
// lead or its assignment was appointed, edited or changed, or the lead is
// already working without this project's earlier import binding it. Everything
// else keeps the prior lead-conflict protection, and an explicit mapping is
// never replaced.
async function planBootstrapLead({ application, personalSpaceId, personalProjectId, policy, leadRole,
  template, roleAgentIds, receipt }) {
  if (!leadRole || roleAgentIds[leadRole.roleKey]) return null;
  const agentId = policy?.team_lead_agent_id ?? null;
  if (!agentId) return null;
  const agent = await agentOrNull(application, personalSpaceId, agentId);
  if (!agent) return null;
  // A retry of this template's own earlier import keeps the same seat even if
  // the lead has since taken work, the imported members now fill the team, or
  // the person edited the assignment. The binding is the draft receipt; a
  // retry whose receipt was not saved is still recognised by the deterministic
  // IDs this import gives its members.
  const binding = receipt?.leadSeat ?? null;
  const bound = Boolean(binding && binding.roleKey === leadRole.roleKey && binding.agentId === agentId);
  const assignment = bootstrapLeadProvenance(agent, policy, personalProjectId, { allowModified: bound });
  if (!assignment) return null;
  const otherMembers = (policy?.team_member_agent_ids ?? []).filter(id => id !== agentId);
  const expectedMembers = template.roles
    .filter(role => role.roleKey !== leadRole.roleKey)
    .map(role => targetAgentIdFor(personalProjectId, role.roleKey));
  const importedMembers = expectedMembers.length > 0
    && otherMembers.length === expectedMembers.length
    && otherMembers.every(id => expectedMembers.includes(id))
    && (policy?.sub_teams ?? []).length === 0;
  const identity = bound || importedMembers;
  if (!identity && leadIsWorking(agent)) return null;
  if (!identity && (otherMembers.length > 0 || (policy?.sub_teams ?? []).length > 0)) return null;
  return { roleKey: leadRole.roleKey, agentId, occupation: agent.occupation?.role ?? null };
}

function planPolicy({ template, roles, lead, leadSeat, policy, conflicts }) {
  const memberAgentIds = roles.filter(role => role.agentId !== lead?.agentId).map(role => role.agentId);
  const subTeams = mappedRelationships(template, roles).subTeams;
  const existingLead = policy?.team_lead_agent_id ?? null;
  const existingMembers = [...new Set(policy?.team_member_agent_ids ?? [])]
    .filter(id => id !== existingLead).sort();
  const existingSubTeams = normalizedSubTeams(policy?.sub_teams ?? []);
  const plannedSubTeams = normalizedSubTeams(subTeams);
  const mappedIds = new Set(roles.map(role => role.agentId));
  const plannedMembers = [...new Set(memberAgentIds)].sort();
  const sameMembers = sameStrings(existingMembers, plannedMembers);
  const sameSubTeams = JSON.stringify(existingSubTeams) === JSON.stringify(plannedSubTeams);
  // An adopted bootstrap lead is the seat the normal entry created, not a
  // person's team: filling the rest of the project is the import's job. Any
  // extra member or sub-team the person added is still their own and keeps the
  // ordinary conflict protection.
  const adopted = Boolean(leadSeat && lead && leadSeat.agentId === lead.agentId);
  // Any member or sub-team the target already has is the target's own team:
  // this import fills an empty project, it never rewrites an existing one.
  const hasLayout = existingMembers.length > 0 || existingSubTeams.length > 0;

  if (!lead) {
    conflicts.push({ code: 'team_template_lead_unmapped',
      message: 'The template lead could not be mapped to an Agent; nothing can be imported.' });
  } else if (existingLead && existingLead !== lead.agentId) {
    conflicts.push({ code: 'team_template_target_lead_conflict',
      message: 'The target project already has a different lead Agent. This import never replaces a working team; '
        + 'use a project with no lead or with the same lead.' });
  } else if (existingLead && hasLayout && (!sameMembers || !sameSubTeams)) {
    if (existingMembers.some(id => !mappedIds.has(id))) {
      conflicts.push({ code: 'team_template_target_members_conflict',
        message: 'The target project already has explicit team members this template does not name; '
          + 'this import does not remove or replace them.' });
    } else if (!sameSubTeams) {
      conflicts.push({ code: 'team_template_target_subteams_conflict',
        message: 'The target project already has a different sub-team layout; this import does not replace it.' });
    } else {
      conflicts.push({ code: 'team_template_target_team_conflict',
        message: 'The target project already has a different team layout; this import does not rewrite it. '
          + 'Change the team in the project itself, or import into a project with no team.' });
    }
  } else if (!existingLead && hasLayout) {
    conflicts.push({ code: 'team_template_target_team_conflict',
      message: 'The target project already names team members without a lead; this import does not rewrite it.' });
  }
  const unchanged = existingLead === (lead?.agentId ?? null) && sameMembers && sameSubTeams;
  return {
    action: unchanged ? 'unchanged' : hasLayout ? 'kept' : 'update',
    leadSeat: adopted ? 'adopted' : 'template',
    teamLeadAgentId: lead?.agentId ?? null,
    teamMemberAgentIds: memberAgentIds,
    subTeams,
    subTeamSuggestionThreshold: policy?.sub_team_suggestion_threshold ?? 6,
    askBeforeRecruitment: policy?.ask_before_recruitment,
    autoReusePreviousAgent: policy?.auto_reuse_previous_agent ?? true,
    autoGrowTeam: policy?.auto_grow_team,
    expectedUpdatedAt: policy?.updated_at ?? null
  };
}

async function planWorkflows(application, personalSpaceId, personalProjectId, template, roles, conflicts) {
  if (!template.workflows.length) return [];
  if (!application.agentWorkflows?.overview || !application.agentWorkflows?.propose) {
    conflicts.push({ code: 'team_template_workflows_unavailable',
      message: 'This installation cannot store Agent workflows, so the template\'s workflows cannot be proposed.' });
    return [];
  }
  const workflows = [];
  for (const workflow of template.workflows) {
    const role = roles.find(item => item.roleKey === workflow.roleKey);
    if (!role) {
      conflicts.push({ code: 'team_template_role_unmapped', roleKey: workflow.roleKey,
        message: `The workflow "${workflow.name}" belongs to a role that could not be mapped.` });
      continue;
    }
    const { workflows: owned = [] } = application.agentWorkflows.overview({ personalSpaceId, agentId: role.agentId });
    const source = workflowSourceOf(personalProjectId, workflow.roleKey, workflow.name);
    const existing = owned.find(item => item.active?.source === source || item.pending?.source === source) ?? null;
    const shown = existing?.active?.source === source ? existing.active : existing?.pending;
    const planned = workflowContent(workflow);
    // A workflow this template already proposed is never rewritten: the
    // target team may have changed it since, and a reimport keeps it.
    const action = !existing ? 'propose'
      : JSON.stringify(workflowContent(shown)) === JSON.stringify(planned) ? 'unchanged' : 'kept';
    workflows.push({
      roleKey: workflow.roleKey,
      agentId: role.agentId,
      name: workflow.name,
      action,
      ...(action === 'kept' ? { reason: 'the target team changed this workflow; a reimport keeps it' } : {}),
      workflowId: existing?.workflowId ?? null,
      source,
      purpose: workflow.purpose,
      steps: workflow.steps,
      ...(workflow.workMap ? { workMap: workflow.workMap } : {}),
      ...(workflow.lesson ? { lesson: workflow.lesson } : {})
    });
  }
  return workflows;
}

// The draft is the target's own: the first import writes it and every later
// import reports what is already there. A source change therefore never
// overwrites a check or a line the target edited or accepted.
function planRecurringJobs(template, roles, lead, draft, conflicts) {
  if (!template.recurringJobs.length) return [];
  const jobs = [];
  for (const job of template.recurringJobs) {
    const role = roles.find(item => item.roleKey === job.roleKey);
    if (!role) {
      conflicts.push({ code: 'team_template_role_unmapped', roleKey: job.roleKey,
        message: `The recurring job "${job.responsibility}" belongs to a role that could not be mapped.` });
      continue;
    }
    if (role.agentId === lead?.agentId) {
      conflicts.push({ code: 'team_template_recurring_job_lead', roleKey: role.roleKey,
        message: 'A recurring job is a line separated from the lead; the template names the lead as its owner.' });
      continue;
    }
    jobs.push({ roleKey: job.roleKey, agentId: role.agentId, responsibility: job.responsibility,
      terms: job.terms,
      action: draft === 'kept' ? 'kept' : draft === 'unchanged' ? 'unchanged' : 'draft' });
  }
  return jobs;
}

function receiptOf(application, personalSpaceId, personalProjectId) {
  try {
    return application.teamTemplateReceipts?.read?.(personalSpaceId, personalProjectId) ?? null;
  } catch {
    return null;
  }
}

// The receipt is written once and read afterwards: a stored copy that differs
// from this template is kept, exactly like a workflow the target changed.
function draftActionOf(receipt, template, leadDraft = null) {
  if (!template.acceptance.length && !template.recurringJobs.length && !leadDraft) return 'none';
  if (!receipt) return 'draft';
  return sameDraft(receipt, template, leadDraft) ? 'unchanged' : 'kept';
}

function sameDraft(receipt, template, leadDraft = null) {
  if (!sameLeadSeat(receipt.leadSeat ?? null, leadDraft)) return false;
  if (receipt.acceptance.length !== template.acceptance.length
      || receipt.recurringBlueprints.length !== template.recurringJobs.length) return false;
  const checks = receipt.acceptance.every((check, index) => {
    const wanted = template.acceptance[index];
    return check.kind === wanted.kind && check.text === wanted.text
      && (check.occupation ?? null) === (wanted.occupation ?? null);
  });
  if (!checks) return false;
  return receipt.recurringBlueprints.every((blueprint, index) => {
    const wanted = template.recurringJobs[index];
    return blueprint.roleKey === wanted.roleKey && blueprint.responsibility === wanted.responsibility
      && sameStrings([...blueprint.terms], [...wanted.terms]);
  });
}

function assertReusableAgent(agent, role, conflicts) {
  const status = agent.profile?.status;
  if (status && status !== 'active') {
    conflicts.push({ code: 'team_template_role_agent_unavailable', roleKey: role.roleKey, agentId: agent.agent_id,
      message: `The Agent for role ${role.roleKey} is ${status}; reactivate it or map another Agent.` });
  }
  const occupation = agent.occupation?.role ?? null;
  if (occupation !== role.occupation.role) {
    conflicts.push({ code: 'team_template_role_occupation_mismatch', roleKey: role.roleKey, agentId: agent.agent_id,
      message: `The Agent for role ${role.roleKey} has occupation ${occupation ?? 'none'}, not ${role.occupation.role}.` });
  }
}

// Whether the Agent already holds an active assignment in this project. The
// provider may spell these fields either way; an ended assignment does not
// count, so a retry after one was ended recreates it.
function hasTargetAssignment(agent, personalProjectId) {
  return (agent.assignments ?? []).some((item) => {
    const projectId = item.personal_project_id ?? item.personalProjectId;
    const ended = item.ended_at ?? item.endedAt;
    return projectId === personalProjectId && !ended && (item.status ?? 'active') === 'active';
  });
}

function mappedRelationships(template, roles) {
  const agentIdOf = new Map(roles.map(role => [role.roleKey, role.agentId]));
  return {
    leadRoleKey: template.relationships.leadRoleKey,
    leadAgentId: agentIdOf.get(template.relationships.leadRoleKey) ?? null,
    reportingLines: template.relationships.reportingLines.map(line => ({
      roleKey: line.roleKey,
      agentId: agentIdOf.get(line.roleKey) ?? null,
      reportsToRoleKey: line.reportsToRoleKey,
      reportsToAgentId: agentIdOf.get(line.reportsToRoleKey) ?? null
    })),
    subTeams: template.relationships.subTeams.map(group => ({
      id: group.id,
      name: group.name,
      leadRoleKey: group.leadRoleKey,
      leadAgentId: agentIdOf.get(group.leadRoleKey) ?? null,
      memberRoleKeys: group.memberRoleKeys,
      memberAgentIds: group.memberRoleKeys.map(key => agentIdOf.get(key) ?? null)
    }))
  };
}

function normalizedSubTeams(subTeams) {
  return subTeams.map(group => ({
    id: group.id,
    name: group.name,
    leadAgentId: group.leadAgentId ?? group.lead_agent_id,
    memberAgentIds: [...new Set(group.memberAgentIds ?? group.member_agent_ids ?? [])].sort()
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function workflowContent(workflow) {
  return {
    name: workflow.name,
    purpose: workflow.purpose,
    steps: workflow.steps,
    ...(workflow.workMap ? { workMap: workflow.workMap } : {}),
    ...(workflow.lesson ? { lesson: {
      trigger: workflow.lesson.trigger,
      scope: workflow.lesson.scope,
      checks: workflow.lesson.checks ?? workflow.lesson.acceptanceEvidence ?? []
    } } : {})
  };
}

function roleAgentIdsOf(value, template) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidInputError('roleAgentIds must be an object mapping role keys to Agent IDs');
  }
  const known = new Set(template.roles.map(role => role.roleKey));
  const mapping = {};
  for (const [roleKey, agentId] of Object.entries(value)) {
    if (!known.has(roleKey)) throw new InvalidInputError('roleAgentIds contains an unknown role key');
    mapping[roleKey] = requiredString(agentId, 'roleAgentIds agent ID', AGENT_ID_MAX);
  }
  return mapping;
}

function sortedMapping(mapping = {}) {
  return Object.fromEntries(Object.entries(mapping).sort(([left], [right]) => left.localeCompare(right)));
}

async function projectOrNull(application, personalSpaceId, personalProjectId) {
  try {
    return await application.personal.getPersonalProject(personalSpaceId, personalProjectId);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function agentOrNull(application, personalSpaceId, agentId) {
  try {
    return await application.personal.getProjectAgent(personalSpaceId, null, agentId);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function targetAgentIdFor(personalProjectId, roleKey) {
  return `tt-${contentHash({ personalProjectId, roleKey }).slice(0, 16)}-${roleKey}`;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// A target's stored lead seat is its own: the first import writes which lead
// Agent and portable role filled the bootstrap seat, and a source change never
// rewrites it.
function sameLeadSeat(stored, wanted) {
  if (!stored && !wanted) return true;
  if (!stored || !wanted) return false;
  return stored.roleKey === wanted.roleKey && stored.agentId === wanted.agentId
    && (stored.occupation ?? null) === wanted.occupation
    && (stored.responsibility ?? '') === wanted.responsibility;
}

function conflictPlan({ template, personalProjectId, confirmationDigest, conflicts }) {
  return { status: 'conflict', templateId: template.templateId, personalProjectId, confirmationDigest,
    lead: null, roles: [], relationships: null, policy: null, workflows: [], acceptance: [], recurringJobs: [],
    conflicts, template };
}
