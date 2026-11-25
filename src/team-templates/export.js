import { ApplicationError } from '../app/application-error.js';
import { projectAcceptanceChecks } from '../acceptance-checks/port.js';
import { applicationLanguage } from '../graphiti/project-display-name.js';
import { buildProjectTeam, isPeerRoleAgent } from '../graphiti/project-team-view.js';
import { isBranchTerm } from '../standing-assignments/term-rules.js';
import { identityKey } from '../text/name-identity.js';
import { requiredString } from '../validation/values.js';
import { singleLineExcerpt } from '../text/single-line.js';
import { portableText } from './portable-text.js';
import { requireTeamTemplateProject } from './project.js';
import { MAX_TEMPLATE_ACCEPTANCE_CHECKS, portableTemplate, roleKeyFor, TEMPLATE_FORMAT, TEMPLATE_FORMAT_VERSION } from './schema.js';

// Exports one complete project team as a portable template. The team's own
// reading (project-team-view.js) is authoritative for who is in it and how
// they report; role identity comes from the Agent's occupation. Optional
// sections are read from the ports that own them and are left out when the
// installation does not support them. Nothing is written except, when the
// description is too large for one answer, a short local reference to it.

const ROLE_LABEL = 'role';
const INLINE_LIMIT_BYTES = 16 * 1024;
const SUMMARY_TEXT = 120;

export async function exportProjectTeamTemplate(application, input) {
  const personalSpaceId = input.personalSpaceId;
  const personalProjectId = requiredString(input.personalProjectId, 'personalProjectId', 256);
  await requireTeamTemplateProject(application, personalSpaceId, personalProjectId);

  const [policy, agents] = await Promise.all([
    application.personal.getProjectAgentCoordinationPolicy(personalSpaceId, personalProjectId),
    application.personal.listProjectAgents(personalSpaceId, personalProjectId, { status: 'active' })
  ]);
  const list = asAgents(agents);
  const team = buildProjectTeam({ policy, agents: list, projectId: personalProjectId,
    language: applicationLanguage(application), standingAssignments: [] });
  const byAgentId = new Map(list.map(agent => [agent.agent_id, agent]));
  const teamPeople = [team.lead, ...team.members].filter(Boolean);
  assertExportableTeam(team, teamPeople, byAgentId);
  const identifiers = sourceIdentifiers(personalSpaceId, personalProjectId, list);

  const usedKeys = new Set();
  const roles = [];
  const roleKeyByAgentId = new Map();
  for (const person of teamPeople) {
    const agent = byAgentId.get(person.agentId);
    if (!agent) throw incomplete(`role ${person.agentId} is not in the active roster`);
    // The occupation is the role's identity, so what travels of it must be
    // portable before a key is derived from it.
    const occupationRole = portableText(agent.occupation?.role, { identifiers }).text;
    const roleKey = roleKeyFor(occupationRole, usedKeys, person.agentId === team.lead?.agentId
      ? 'lead' : ROLE_LABEL);
    roleKeyByAgentId.set(person.agentId, roleKey);
    roles.push(roleOf(agent, person, roleKey, occupationRole));
  }

  const relationships = relationshipsOf(team, roleKeyByAgentId);
  const [workflows, acceptance, recurringJobs] = await Promise.all([
    exportWorkflows(application, personalSpaceId, personalProjectId, roleKeyByAgentId),
    exportAcceptance(application, personalSpaceId, personalProjectId),
    exportRecurringJobs(application, personalSpaceId, personalProjectId, team, roleKeyByAgentId)
  ]);

  const { template, redactions } = portableTemplate({
    format: TEMPLATE_FORMAT,
    formatVersion: TEMPLATE_FORMAT_VERSION,
    roles,
    relationships,
    workflows,
    acceptance,
    recurringJobs,
    exportedAt: new Date().toISOString()
  }, { requireId: false, identifiers });

  // The whole template goes inline when it fits one answer; otherwise only
  // this computer's short reference does. A small template keeps no reference.
  const inline = Buffer.byteLength(JSON.stringify(template), 'utf8') <= INLINE_LIMIT_BYTES;
  const templateRef = !inline && application.teamTemplateRefs?.put
    ? application.teamTemplateRefs.put(template, { personalSpaceId, sourcePersonalProjectId: personalProjectId })
    : null;
  if (!inline && !templateRef) {
    throw new ApplicationError('team_template_too_large',
      'This team description is larger than one FULI answer and this installation cannot keep a local reference. '
      + 'Nothing was exported.', { status: 413 });
  }

  return {
    status: 'exported',
    templateId: template.templateId,
    ...(inline ? { template } : {}),
    ...(templateRef ? { templateRef } : {}),
    counts: {
      roles: template.roles.length,
      workflows: template.workflows.length,
      acceptance: template.acceptance.length,
      recurringJobs: template.recurringJobs.length
    },
    redacted: redactions,
    roles: template.roles.map(role => ({ roleKey: role.roleKey, occupation: role.occupation.role,
      responsibility: singleLineExcerpt(role.responsibility, SUMMARY_TEXT) })),
    next: inline
      ? 'Pass the template to preview_project_team_template_import for the destination project.'
      : 'The template is kept locally; pass its templateRef to preview and import on this computer.'
  };
}

function sourceIdentifiers(personalSpaceId, personalProjectId, agents) {
  const identifiers = [personalSpaceId, personalProjectId];
  // An occupation is a role, not a person. A source FLA may be named after the
  // role it fills ("engineering"), and neither that name nor an Agent ID that
  // happens to equal a role may mask the role the template must carry.
  const roles = new Set(agents.map(agent => identityText(agent.occupation?.role)).filter(Boolean));
  for (const agent of agents) {
    for (const value of [agent.agent_id, agent.profile?.display_name, agent.profile?.displayName,
      agent.profile?.name]) {
      if (typeof value === 'string' && value.length >= 4 && !roles.has(identityText(value))) {
        identifiers.push(value);
      }
    }
  }
  return identifiers;
}

// Two spellings of the same name are the same identity here: spacing, case and
// compatibility forms must not turn a role into a source identifier.
function identityText(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

function roleOf(agent, person, roleKey, occupationRole) {
  const profile = agent.profile ?? {};
  if (!occupationRole) {
    throw incomplete(`role ${roleKey} has no occupation, so FULI cannot recreate it in another project`);
  }
  const agentType = profile.agent_type ?? profile.agentType ?? 'durable';
  if (agentType === 'temporary' || agentType === 'hr') {
    throw incomplete(`role ${roleKey} is ${agentType} and is not part of a portable project team`);
  }
  return {
    roleKey,
    responsibility: person.responsibility || profile.responsibility || '',
    occupation: { role: occupationRole, tags: agent.occupation?.tags ?? [] },
    capabilities: profile.capabilities ?? [],
    workKinds: profile.work_kinds ?? profile.workKinds ?? [],
    agentType: agentType === 'coordinator' ? 'coordinator' : 'durable'
  };
}

function relationshipsOf(team, roleKeyByAgentId) {
  const leadRoleKey = roleKeyByAgentId.get(team.lead.agentId);
  const reportingLines = team.members.map(member => ({
    roleKey: roleKeyByAgentId.get(member.agentId),
    reportsToRoleKey: roleKeyByAgentId.get(member.reportsToAgentId)
  })).filter(line => line.roleKey && line.reportsToRoleKey);
  const subTeams = team.subTeams.map((group, index) => {
    if (!group.lead) {
      throw incomplete(`sub-team ${group.name ?? index + 1} has no available lead`);
    }
    if (group.unavailableMemberIds.length) {
      throw incomplete(`sub-team ${group.name ?? index + 1} has unavailable members`);
    }
    return {
      id: group.id ?? `sub-team-${index + 1}`,
      name: group.name,
      leadRoleKey: roleKeyByAgentId.get(group.lead.agentId),
      memberRoleKeys: group.members.map(member => roleKeyByAgentId.get(member.agentId)).filter(Boolean)
    };
  });
  return { leadRoleKey, reportingLines, subTeams };
}

async function exportWorkflows(application, personalSpaceId, personalProjectId, roleKeyByAgentId) {
  if (!application.agentWorkflows?.overview) return [];
  const workflows = [];
  for (const [agentId, roleKey] of roleKeyByAgentId) {
    const { workflows: owned } = application.agentWorkflows.overview({ personalSpaceId, agentId });
    for (const workflow of owned ?? []) {
      if (workflow.status !== 'active' || !workflow.active) continue;
      if (workflow.personalProjectId !== personalProjectId) continue;
      const active = workflow.active;
      workflows.push({
        roleKey,
        name: active.name,
        purpose: active.purpose,
        steps: (active.steps ?? []).map(step => ({
          title: step.title,
          ...(step.detail ? { detail: step.detail } : {})
        })),
        ...(active.workMap ? { workMap: active.workMap } : {}),
        // A confirmed workflow's reusable lesson travels as when it applies,
        // its boundary and the checks that showed it worked. The person's
        // words, the completed delivery and its evidence stay with the source.
        ...(active.lesson ? { lesson: {
          trigger: active.lesson.trigger,
          scope: active.lesson.scope,
          checks: active.lesson.acceptanceEvidence ?? []
        } } : {})
      });
    }
  }
  return workflows;
}

async function exportAcceptance(application, personalSpaceId, personalProjectId) {
  if (typeof application.personal.graph !== 'function') return [];
  let result;
  try {
    result = await projectAcceptanceChecks(application,
      { personalSpaceId, personalProjectId, limit: MAX_TEMPLATE_ACCEPTANCE_CHECKS + 1 });
  } catch {
    throw new ApplicationError('team_template_acceptance_unavailable',
      'Retry the export when the source project graph and roster are available.', { status: 503 });
  }
  const { checks, partial } = result;
  if (partial) throw incomplete('only part of the source project graph was read');
  if (checks.length > MAX_TEMPLATE_ACCEPTANCE_CHECKS) {
    throw incomplete(`the template supports at most ${MAX_TEMPLATE_ACCEPTANCE_CHECKS} acceptance checks`);
  }
  return checks.map(check => ({ kind: check.kind, text: check.text, occupation: check.occupation ?? null }));
}

function exportRecurringJobs(application, personalSpaceId, personalProjectId, team, roleKeyByAgentId) {
  const assigned = application.standingAssignments?.list?.(personalSpaceId);
  if (!Array.isArray(assigned)) return [];
  const leadAgentId = team.lead?.agentId ?? null;
  const jobs = [];
  const roles = new Set();
  for (const assignment of assigned) {
    if (assignment.projectId !== personalProjectId || assignment.retiredAt) continue;
    // A workstream separates one line of work from the lead; the project's own
    // routing rule is the target project's business, never carried across.
    if (assignment.leadAgentId === leadAgentId) continue;
    const roleKey = roleKeyByAgentId.get(assignment.leadAgentId);
    if (!roleKey || roles.has(roleKey)) continue;
    const terms = (assignment.terms ?? []).filter(term => !isBranchTerm(identityKey(term)));
    if (!terms.length) continue;
    roles.add(roleKey);
    jobs.push({ roleKey, responsibility: assignment.responsibility, terms });
  }
  return jobs;
}

function assertExportableTeam(team, people, byAgentId) {
  if (team.status !== 'ready' || !team.lead) {
    throw incomplete(team.status === 'no_lead'
      ? 'the project has no lead, so it has no complete team to export'
      : 'the project lead is unavailable, so it has no complete team to export');
  }
  if (team.unavailableMemberIds.length) {
    throw incomplete('the team names unavailable members');
  }
  if (team.unavailableLead) {
    throw incomplete('the team names an unavailable lead');
  }
  if (!people.length) throw incomplete('the project has no team members to export');
  // FULI's own roles are peers of a project team, never its members, and a
  // template never recreates them elsewhere.
  for (const person of people) {
    const agent = byAgentId.get(person.agentId);
    if (agent && isPeerRoleAgent({ agentId: agent.agent_id, agentType: agent.profile?.agent_type,
      capabilities: agent.profile?.capabilities ?? [] })) {
      throw incomplete('the team includes one of FULI\'s own roles, which is a peer rather than a team member');
    }
  }
}

function incomplete(reason) {
  return new ApplicationError('team_template_team_incomplete',
    `This project team cannot be exported: ${reason}.`, { status: 409 });
}

function asAgents(value) {
  if (Array.isArray(value)) return value;
  return value?.agents ?? value?.items ?? [];
}
