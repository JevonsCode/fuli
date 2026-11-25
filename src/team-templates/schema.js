import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { assertJsonObject, requiredString, uniqueTextArray } from '../validation/values.js';
import { addRedaction, emptyRedactions, portableText } from './portable-text.js';

// A portable project team template: who the project's roles are, what each is
// responsible for, how they report, the procedures the team confirmed, the
// checks it learned, and the recurring lines of work. It is a description of a
// team, never a copy of its memory, chats, identifiers, paths or access.
//
// The format is versioned. The digest covers every portable part; exportedAt
// is metadata and stays outside it, so two exports of one unchanged team have
// the same templateId and an import retry can recognise its own work.

export const TEMPLATE_FORMAT = 'fuli-project-team-template';
export const TEMPLATE_FORMAT_VERSION = 1;
export const MAX_TEMPLATE_ACCEPTANCE_CHECKS = 50;
const TEMPLATE_DIGEST_LENGTH = 64;

const LIMITS = Object.freeze({
  roles: 32,
  roleKey: 64,
  responsibility: 4096,
  capabilities: 32,
  capability: 512,
  workKinds: 32,
  workKind: 512,
  occupationRole: 128,
  occupationTags: 16,
  occupationTag: 64,
  subTeams: 32,
  subTeamId: 64,
  subTeamName: 120,
  reportingLines: 31,
  workflows: 200,
  workflowName: 80,
  workflowPurpose: 300,
  steps: 20,
  stepTitle: 120,
  stepDetail: 600,
  workMapItems: 10,
  lessonTrigger: 200,
  lessonScope: 300,
  lessonChecks: 6,
  lessonCheck: 300,
  acceptance: MAX_TEMPLATE_ACCEPTANCE_CHECKS,
  acceptanceText: 2048,
  recurringJobs: 32,
  jobResponsibility: 240,
  terms: 20,
  term: 80,
  exportedAt: 64,
  overallBytes: 512 * 1024
});

const AGENT_TYPES = new Set(['durable', 'coordinator']);
const CHECK_KINDS = new Set(['acceptance_item', 'regression_example']);
const WORK_MAP_LISTS = ['inputs', 'outputs', 'dependencies', 'branches', 'acceptance'];
const WORK_MAP_REQUIRED = ['inputs', 'outputs', 'acceptance'];
const ROLE_KEY = /^[a-z0-9][a-z0-9-]*$/;
const SUB_TEAM_ID = /^[a-z0-9][a-z0-9_-]*$/;

// A stable key for a role. The built-in occupation is the role's identity;
// roles without one use a readable fallback, and duplicates gain a suffix.
export function roleKeyFor(label, used = new Set(), fallback = 'role') {
  const base = slugText(label, 56) || fallback;
  let key = base;
  for (let index = 2; used.has(key); index += 1) {
    const suffix = `-${index}`;
    key = `${base.slice(0, 56 - suffix.length)}${suffix}`;
  }
  used.add(key);
  return key;
}

// A slug safe in the deterministic Agent ID and in a workflow source.
export function slugText(value, maximum = 40) {
  return String(value ?? '').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, maximum);
}

function templateContent(value) {
  return {
    format: value.format,
    formatVersion: value.formatVersion,
    roles: value.roles,
    relationships: value.relationships,
    workflows: value.workflows,
    acceptance: value.acceptance,
    recurringJobs: value.recurringJobs
  };
}

function templateIdOf(value) {
  return contentHash(templateContent(value));
}

// Parses a template (or a template body) into its portable shape without
// sanitizing or checking the digest. requireId is false only while FULI is
// building one.
function parsedTemplate(value) {
  assertJsonObject(value, 'template');
  if (value.format !== TEMPLATE_FORMAT) {
    throw invalid(`template.format must be "${TEMPLATE_FORMAT}"`);
  }
  if (value.formatVersion !== TEMPLATE_FORMAT_VERSION) {
    throw new ApplicationError('team_template_version_unsupported',
      `This template format version is not supported; this FULI reads version ${TEMPLATE_FORMAT_VERSION}. `
      + 'Export the team again from a FULI that writes a supported version.', { status: 422 });
  }
  if (JSON.stringify(value).length > LIMITS.overallBytes) {
    throw invalid('template is too large');
  }
  const body = {
    format: TEMPLATE_FORMAT,
    formatVersion: TEMPLATE_FORMAT_VERSION,
    roles: rolesOf(value.roles),
    relationships: relationshipsOf(value.relationships),
    workflows: workflowsOf(value.workflows),
    acceptance: acceptanceOf(value.acceptance),
    recurringJobs: recurringJobsOf(value.recurringJobs)
  };
  const exportedAt = exportedAtOf(value.exportedAt);
  return { ...body, ...(exportedAt ? { exportedAt } : {}) };
}

// A validated template whose free text is portable, plus what was replaced.
// A template that already carries a templateId keeps it only when the digest
// matches either its original or its sanitized content; a template that was
// changed by hand is refused. Redaction changes the digest, so FULI reseals
// the sanitized body and reports the count instead of repeating any value.
export function portableTemplate(value, { requireId = true, identifiers = [] } = {}) {
  const raw = parsedTemplate(value);
  const { body, redactions } = sanitizeTemplateBody(raw, { identifiers });
  let template = { ...body, ...(raw.exportedAt ? { exportedAt: raw.exportedAt } : {}) };
  if (requireId) {
    const templateId = requiredString(value.templateId, 'template.templateId', TEMPLATE_DIGEST_LENGTH);
    const cleanId = templateIdOf(template);
    if (templateId !== cleanId && templateId !== templateIdOf(raw)) {
      throw invalid('template.templateId does not match the template content; export the team again');
    }
    template = { ...template, templateId: cleanId };
  } else {
    template = { ...template, templateId: templateIdOf(template) };
  }
  assertRelationshipsMatchRoles(template.roles, template.relationships);
  const roleKeys = new Set(template.roles.map(role => role.roleKey));
  const workflowNames = new Set();
  for (const workflow of template.workflows) {
    if (!roleKeys.has(workflow.roleKey)) throw invalid(`a workflow names unknown role "${workflow.roleKey}"`);
    const key = `${workflow.roleKey}\u0000${workflow.name}`;
    if (workflowNames.has(key)) throw invalid('two workflows of one role have the same name after redaction; export again');
    workflowNames.add(key);
  }
  for (const job of template.recurringJobs) {
    if (!roleKeys.has(job.roleKey)) throw invalid(`a recurring job names unknown role "${job.roleKey}"`);
  }
  return { template, redactions };
}

// Masks or drops every free-text part of a parsed template. A term, tag or
// capability that was changed would no longer match anything, so it is
// dropped; descriptions keep their meaning around a marker.
function sanitizeTemplateBody(body, { identifiers = [] } = {}) {
  const redactions = emptyRedactions();
  const text = (value) => {
    const result = portableText(value, { identifiers });
    addRedaction(redactions, result.reasons);
    return result.text;
  };
  const drop = (value) => {
    const result = portableText(value, { identifiers });
    addRedaction(redactions, result.reasons, { dropped: result.reasons.length > 0 });
    return result.reasons.length ? null : result.text;
  };
  const dropped = items => items.map(drop).filter(item => item !== null);
  const masked = items => items.map(text);

  const roles = body.roles.map(role => ({
    roleKey: role.roleKey,
    responsibility: text(role.responsibility),
    occupation: {
      role: text(role.occupation.role),
      tags: dropped(role.occupation.tags)
    },
    capabilities: dropped(role.capabilities),
    workKinds: dropped(role.workKinds),
    agentType: role.agentType
  }));
  const relationships = {
    leadRoleKey: body.relationships.leadRoleKey,
    reportingLines: body.relationships.reportingLines,
    subTeams: body.relationships.subTeams.map(group => ({ ...group, name: text(group.name) }))
  };
  const workflows = body.workflows.map(workflow => ({
    roleKey: workflow.roleKey,
    name: text(workflow.name),
    purpose: text(workflow.purpose),
    steps: workflow.steps.map(step => ({
      title: text(step.title),
      ...(step.detail ? { detail: text(step.detail) } : {})
    })),
    ...(workflow.workMap ? { workMap: workMapText(workflow.workMap, text) } : {}),
    ...(workflow.lesson ? { lesson: {
      trigger: text(workflow.lesson.trigger),
      scope: text(workflow.lesson.scope),
      checks: masked(workflow.lesson.checks)
    } } : {})
  }));
  const acceptance = body.acceptance.map(check => ({ ...check, text: text(check.text) }));
  const recurringJobs = body.recurringJobs.map(job => ({
    roleKey: job.roleKey,
    responsibility: text(job.responsibility),
    terms: dropped(job.terms)
  })).filter(job => job.terms.length);
  return {
    body: { ...body, roles, relationships, workflows, acceptance, recurringJobs },
    redactions
  };
}

function workMapText(workMap, text) {
  return {
    ...workMap,
    inputs: workMap.inputs.map(text),
    outputs: workMap.outputs.map(text),
    dependencies: workMap.dependencies.map(text),
    branches: workMap.branches.map(text),
    acceptance: workMap.acceptance.map(text),
    questions: workMap.questions.map(text)
  };
}

function rolesOf(value) {
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.roles) {
    throw invalid(`template.roles must list 1 to ${LIMITS.roles} roles`);
  }
  const keys = new Set();
  return value.map((role, index) => {
    const label = `template.roles[${index}]`;
    assertJsonObject(role, label);
    const roleKey = roleKeyOf(role.roleKey, `${label}.roleKey`, keys);
    const occupation = role.occupation;
    assertJsonObject(occupation, `${label}.occupation`);
    const occupationRole = requiredString(occupation.role, `${label}.occupation.role`, LIMITS.occupationRole);
    const occupationTags = tagsOf(occupation.tags, `${label}.occupation.tags`);
    const capabilities = textListOf(role.capabilities, `${label}.capabilities`, LIMITS.capabilities, LIMITS.capability);
    if (capabilities.some(capability => /^fuli\.employee:/i.test(capability))) {
      throw invalid(`${label}.capabilities may not carry a FULI built-in role; a template describes a project team, not FULI itself`);
    }
    const workKinds = textListOf(role.workKinds, `${label}.workKinds`, LIMITS.workKinds, LIMITS.workKind);
    const agentType = role.agentType ?? 'durable';
    if (!AGENT_TYPES.has(agentType)) {
      throw invalid(`${label}.agentType must be durable or coordinator; temporary and FULI's own roles are not portable`);
    }
    return {
      roleKey,
      responsibility: requiredString(role.responsibility, `${label}.responsibility`, LIMITS.responsibility),
      occupation: { role: occupationRole, tags: occupationTags },
      capabilities,
      workKinds,
      agentType
    };
  });
}

function relationshipsOf(value) {
  assertJsonObject(value, 'template.relationships');
  const leadRoleKey = requiredString(value.leadRoleKey, 'template.relationships.leadRoleKey', LIMITS.roleKey);
  const lines = reportingLinesOf(value.reportingLines);
  const subTeams = subTeamsOf(value.subTeams);
  return { leadRoleKey, reportingLines: lines, subTeams };
}

function reportingLinesOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.reportingLines) {
    throw invalid(`template.relationships.reportingLines lists at most ${LIMITS.reportingLines} lines`);
  }
  const seen = new Set();
  return value.map((line, index) => {
    const label = `template.relationships.reportingLines[${index}]`;
    assertJsonObject(line, label);
    const roleKey = requiredString(line.roleKey, `${label}.roleKey`, LIMITS.roleKey);
    const reportsToRoleKey = requiredString(line.reportsToRoleKey, `${label}.reportsToRoleKey`, LIMITS.roleKey);
    if (roleKey === reportsToRoleKey) throw invalid(`${label} reports to itself`);
    if (seen.has(roleKey)) throw invalid(`${label} names a role that already has a reporting line`);
    seen.add(roleKey);
    return { roleKey, reportsToRoleKey };
  });
}

function subTeamsOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.subTeams) {
    throw invalid(`template.relationships.subTeams lists at most ${LIMITS.subTeams} sub-teams`);
  }
  const ids = new Set();
  const memberOwners = new Set();
  return value.map((group, index) => {
    const label = `template.relationships.subTeams[${index}]`;
    assertJsonObject(group, label);
    const name = requiredString(group.name, `${label}.name`, LIMITS.subTeamName);
    const id = group.id == null ? slugText(name, LIMITS.subTeamId) || `sub-team-${index + 1}`
      : requiredString(group.id, `${label}.id`, LIMITS.subTeamId);
    if (!SUB_TEAM_ID.test(id)) throw invalid(`${label}.id must use lowercase letters, numbers, "-" or "_"`);
    if (ids.has(id)) throw invalid(`${label}.id is used more than once`);
    ids.add(id);
    const leadRoleKey = requiredString(group.leadRoleKey, `${label}.leadRoleKey`, LIMITS.roleKey);
    const memberRoleKeys = roleKeyListOf(group.memberRoleKeys, `${label}.memberRoleKeys`);
    for (const member of memberRoleKeys) {
      if (memberOwners.has(member)) throw invalid(`${label}.memberRoleKeys names a role that is already in a sub-team`);
      memberOwners.add(member);
    }
    return { id, name, leadRoleKey, memberRoleKeys };
  });
}

function workflowsOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.workflows) {
    throw invalid(`template.workflows lists at most ${LIMITS.workflows} workflows`);
  }
  const named = new Set();
  return value.map((workflow, index) => {
    const label = `template.workflows[${index}]`;
    assertJsonObject(workflow, label);
    const roleKey = requiredString(workflow.roleKey, `${label}.roleKey`, LIMITS.roleKey);
    const name = requiredString(workflow.name, `${label}.name`, LIMITS.workflowName);
    const key = `${roleKey}\u0000${name}`;
    if (named.has(key)) throw invalid(`${label} repeats a workflow name for its role`);
    named.add(key);
    return {
      roleKey,
      name,
      purpose: requiredString(workflow.purpose, `${label}.purpose`, LIMITS.workflowPurpose),
      steps: stepsOf(workflow.steps, `${label}.steps`),
      ...(workflow.workMap == null ? {} : { workMap: workMapOf(workflow.workMap, `${label}.workMap`) }),
      ...(workflow.lesson == null ? {} : { lesson: lessonOf(workflow.lesson, `${label}.lesson`) })
    };
  });
}

// What a confirmed workflow learned, kept only when it transfers: when it
// applies, its boundary and the checks that showed it worked. The source
// delivery, the person's words and any link to the old task stay behind.
function lessonOf(value, label) {
  assertJsonObject(value, label);
  const checks = textListOf(value.checks, `${label}.checks`, LIMITS.lessonChecks, LIMITS.lessonCheck);
  if (!checks.length) throw invalid(`${label}.checks needs at least one item`);
  return {
    trigger: requiredString(value.trigger, `${label}.trigger`, LIMITS.lessonTrigger),
    scope: requiredString(value.scope, `${label}.scope`, LIMITS.lessonScope),
    checks
  };
}

function stepsOf(value, stepsLabel) {
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.steps) {
    throw invalid(`${stepsLabel} must list 1 to ${LIMITS.steps} steps`);
  }
  return value.map((step, index) => {
    const label = `${stepsLabel}[${index}]`;
    assertJsonObject(step, label);
    const title = requiredString(step.title, `${label}.title`, LIMITS.stepTitle);
    const detail = step.detail == null ? null : requiredString(step.detail, `${label}.detail`, LIMITS.stepDetail);
    return { title, ...(detail ? { detail } : {}) };
  });
}

function workMapOf(value, label) {
  assertJsonObject(value, label);
  const normalized = {};
  for (const name of WORK_MAP_LISTS) {
    normalized[name] = textListOf(value[name], `${label}.${name}`, LIMITS.workMapItems, LIMITS.stepDetail);
  }
  for (const name of WORK_MAP_REQUIRED) {
    if (!normalized[name].length) throw invalid(`${label}.${name} needs at least one item`);
  }
  normalized.questions = textListOf(value.questions, `${label}.questions`, LIMITS.workMapItems, LIMITS.stepDetail);
  return normalized;
}

function acceptanceOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.acceptance) {
    throw invalid(`template.acceptance lists at most ${LIMITS.acceptance} checks`);
  }
  return value.map((check, index) => {
    const label = `template.acceptance[${index}]`;
    assertJsonObject(check, label);
    if (!CHECK_KINDS.has(check.kind)) {
      throw invalid(`${label}.kind must be ${[...CHECK_KINDS].join(' or ')}`);
    }
    return {
      kind: check.kind,
      text: requiredString(check.text, `${label}.text`, LIMITS.acceptanceText),
      occupation: check.occupation == null ? null
        : requiredString(check.occupation, `${label}.occupation`, LIMITS.occupationRole)
    };
  });
}

function recurringJobsOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.recurringJobs) {
    throw invalid(`template.recurringJobs lists at most ${LIMITS.recurringJobs} jobs`);
  }
  const roles = new Set();
  return value.map((job, index) => {
    const label = `template.recurringJobs[${index}]`;
    assertJsonObject(job, label);
    const roleKey = requiredString(job.roleKey, `${label}.roleKey`, LIMITS.roleKey);
    if (roles.has(roleKey)) throw invalid(`${label} repeats a role that already owns a recurring job`);
    roles.add(roleKey);
    const terms = textListOf(job.terms, `${label}.terms`, LIMITS.terms, LIMITS.term);
    if (!terms.length) throw invalid(`${label}.terms needs at least one term`);
    if (terms.some(term => term.toLowerCase().startsWith('branch:'))) {
      throw invalid(`${label}.terms names a branch; branch terms belong to one machine and are not portable`);
    }
    return {
      roleKey,
      responsibility: requiredString(job.responsibility, `${label}.responsibility`, LIMITS.jobResponsibility),
      terms
    };
  });
}

// The relationships are checked against the roles once both are parsed.
function assertRelationshipsMatchRoles(roles, relationships) {
  const roleKeys = new Set(roles.map(role => role.roleKey));
  const lead = relationships.leadRoleKey;
  if (!roleKeys.has(lead)) throw invalid('template.relationships.leadRoleKey names no role');
  const parents = new Map(relationships.reportingLines.map(line => [line.roleKey, line.reportsToRoleKey]));
  for (const [roleKey, parent] of parents) {
    if (!roleKeys.has(roleKey)) throw invalid(`template.relationships.reportingLines names unknown role "${roleKey}"`);
    if (roleKey === lead) throw invalid('the lead cannot report to another role');
    if (!roleKeys.has(parent)) throw invalid(`a reporting line names unknown parent "${parent}"`);
  }
  for (const roleKey of roleKeys) {
    if (roleKey === lead) continue;
    if (!parents.has(roleKey)) throw invalid(`role "${roleKey}" has no reporting line`);
    assertNoCycle(roleKey, parents);
  }
  const subTeamLeads = new Set();
  for (const group of relationships.subTeams) {
    if (!roleKeys.has(group.leadRoleKey)) throw invalid(`sub-team "${group.name}" names unknown lead "${group.leadRoleKey}"`);
    if (group.leadRoleKey === lead) throw invalid(`sub-team "${group.name}" makes the project lead its own sub-lead`);
    subTeamLeads.add(group.leadRoleKey);
    for (const member of group.memberRoleKeys) {
      if (!roleKeys.has(member)) throw invalid(`sub-team "${group.name}" names unknown member "${member}"`);
      if (member === lead) throw invalid(`sub-team "${group.name}" includes the project lead as a member`);
    }
  }
  // The authoritative model derives a member's parent from its sub-team; a
  // template that says otherwise cannot be imported faithfully.
  for (const roleKey of roleKeys) {
    if (roleKey === lead) continue;
    const subTeam = relationships.subTeams.find(group => group.memberRoleKeys.includes(roleKey));
    const expected = subTeam ? subTeam.leadRoleKey : lead;
    const actual = parents.get(roleKey);
    if (actual !== expected) {
      throw invalid(`role "${roleKey}" reports to "${actual}" but its sub-team says "${expected}"`);
    }
  }
  return { lead, subTeamLeads };
}

// What a plan or import may use: a template whose relationships agree.

function assertNoCycle(start, parents) {
  const seen = new Set();
  let current = start;
  while (parents.has(current)) {
    if (seen.has(current)) throw invalid(`the reporting lines form a cycle at "${current}"`);
    seen.add(current);
    current = parents.get(current);
  }
}

function roleKeyOf(value, label, used) {
  const roleKey = requiredString(value, label, LIMITS.roleKey);
  if (!ROLE_KEY.test(roleKey)) throw invalid(`${label} must use lowercase letters, numbers or "-"`);
  if (used.has(roleKey)) throw invalid(`${label} is used more than once`);
  used.add(roleKey);
  return roleKey;
}

function roleKeyListOf(value, label) {
  const list = textListOf(value, label, LIMITS.roles, LIMITS.roleKey);
  for (const roleKey of list) {
    if (!ROLE_KEY.test(roleKey)) throw invalid(`${label} names an invalid role key "${roleKey}"`);
  }
  return list;
}

function tagsOf(value, label) {
  return textListOf(value, label, LIMITS.occupationTags, LIMITS.occupationTag);
}

function textListOf(value, label, maximum, itemMaximum) {
  const list = uniqueTextArray(value, label, maximum);
  if (list.some(item => item.length > itemMaximum)) throw invalid(`${label} has an item longer than ${itemMaximum} characters`);
  return list;
}

function exportedAtOf(value) {
  if (value === undefined || value === null) return null;
  const text = requiredString(value, 'template.exportedAt', LIMITS.exportedAt);
  if (Number.isNaN(Date.parse(text))) throw invalid('template.exportedAt must be a date-time');
  return text;
}

function invalid(message) {
  return new InvalidInputError(message);
}
