import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { createTeamTemplateRefs } from '../src/team-templates/refs.js';
import { workflowSourceOf } from '../src/team-templates/import.js';
import {
  SPACE, SOURCE, TARGET,
  agent, assignment, callTeamTool, exportedTemplate, sourceWorld, targetWorld, taskTokenFor, world
} from './fixtures/project-team-template.js';

// A portable project team template moves who works on a project and how they
// report, never the project's memory. These tests drive the real Agent tool
// entry, the real team reading, and the real workflow and standing-assignment
// stores against an in-memory Provider double; no real FULI data is read. The
// bootstrap lead-seat cases have their own file.

test('a project team exports identities, reporting, workflows and recurring work without its memory', async (t) => {
  const { app } = sourceWorld(t);
  const result = await callTeamTool(app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });

  assert.equal(result.status, 'exported');
  assert.deepEqual(result.counts, { roles: 3, workflows: 1, acceptance: 0, recurringJobs: 1 });
  assert.match(result.template.templateId, /^[0-9a-f]{64}$/);
  assert.equal(result.templateRef, undefined, 'a small template travels inline');

  const roles = new Map(result.template.roles.map(role => [role.roleKey, role]));
  assert.deepEqual([...roles.keys()], ['planner', 'builder', 'reviewer']);
  assert.deepEqual(roles.get('builder').occupation, { role: 'builder', tags: [] });
  assert.equal(result.template.relationships.leadRoleKey, 'planner');
  assert.deepEqual(result.template.relationships.reportingLines, [
    { roleKey: 'builder', reportsToRoleKey: 'planner' },
    { roleKey: 'reviewer', reportsToRoleKey: 'planner' }
  ]);

  const [workflow] = result.template.workflows;
  assert.deepEqual([workflow.roleKey, workflow.name, workflow.steps.length], ['builder', 'Synthetic release check', 2]);
  assert.equal(workflow.lesson, undefined, 'an ordinary workflow has no lesson to carry');
  assert.deepEqual(result.template.recurringJobs, [
    { roleKey: 'builder', responsibility: 'Cut a synthetic release', terms: ['synthetic release'] }
  ]);

  const portable = JSON.stringify(result.template);
  for (const forbidden of ['personalSpaceId', 'agentId', 'displayName', 'password', 'accessToken', '/mnt/',
    'sourceAgentId', 'conversation-source-synthetic', '下次也这样做']) {
    assert.equal(portable.includes(forbidden), false, `template must not carry ${forbidden}`);
  }
});

test('export distinguishes a missing acceptance capability from failed or partial source reads', async t => {
  const { app } = sourceWorld(t, { checks: true });
  const exportTeam = () => callTeamTool(app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  const graph = app.personal.graph.bind(app.personal);
  app.personal.graph = async () => { throw new Error('source graph unavailable'); };
  await assert.rejects(exportTeam(), { code: 'team_template_acceptance_unavailable' });
  for (const next_offset of [1, null]) {
    app.personal.graph = async (...args) => ({ ...await graph(...args), truncated: true, next_offset });
    await assert.rejects(exportTeam(), /only part of the source project graph/);
  }
  app.personal.graph = async (...args) => {
    const page = await graph(...args);
    return { ...page, nodes: Array.from({ length: 51 }, (_, index) => ({ ...page.nodes[0], id: `check-${index}` })) };
  };
  await assert.rejects(exportTeam(), /at most 50 acceptance checks/);
  app.personal.graph = graph;
  assert.equal((await exportTeam()).counts.acceptance, 1);
  app.listProjectAgents = async () => { throw new Error('source roster unavailable'); };
  await assert.rejects(exportTeam(), { code: 'team_template_acceptance_unavailable' });
  delete app.personal.graph;
  assert.equal((await exportTeam()).counts.acceptance, 0);
});

test('free text names no secret, host path, person or source identifier after export and import', async (t) => {
  const worldIn = world(t, {
    projects: [{ projectId: SOURCE, profile: { name: 'Synthetic source' } }],
    agents: [
      agent({ id: 'lead-1', occupation: 'planner',
        responsibility: 'Plan with member-1 at alice@example.com',
        assignments: [assignment({ projectId: SOURCE, agentId: 'lead-1',
          responsibility: 'Plan with member-1 at alice@example.com' })] }),
      agent({ id: 'member-1', occupation: 'builder',
        responsibility: 'Build it; password = synthetic-secret',
        assignments: [assignment({ projectId: SOURCE, agentId: 'member-1',
          responsibility: 'Build it; password = synthetic-secret' })] })
    ]
  });
  worldIn.provider.state.policies.set(SOURCE, {
    personal_space_id: SPACE, personal_project_id: SOURCE,
    team_lead_agent_id: 'lead-1', team_member_agent_ids: ['member-1'], sub_teams: [],
    sub_team_suggestion_threshold: 6, updated_at: '2026-02-01T00:00:00.000Z'
  });
  const owner = { personalSpaceId: SPACE, agentId: 'member-1', personalProjectId: SOURCE };
  const proposal = worldIn.workflows.propose(owner, {
    name: 'Synthetic redaction check',
    purpose: 'Check a synthetic build at http://127.0.0.1:2828/settings', source: 'agent',
    steps: [{ title: 'Open C:\\synthetic\\notes', detail: 'token = synthetic0123456789abcdef' }]
  });
  worldIn.workflows.decide({ personalSpaceId: SPACE, workflowId: proposal.workflow.workflowId,
    decision: 'confirm', version: 1 });
  worldIn.assignments.register({ personalSpaceId: SPACE, projectId: SOURCE, leadAgentId: 'member-1',
    terms: ['C:\\synthetic\\release'], responsibility: 'Cut a synthetic release', preferenceIds: [],
    source: 'host', sourceConversationId: null });

  const exported = await callTeamTool(worldIn.app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  assert.ok(exported.redacted.fields >= 4, 'redaction counts the fields it changed');
  assert.ok(exported.redacted.dropped >= 1, 'a term that cannot survive redaction is dropped');
  for (const reason of ['credential_assignment', 'host_path', 'person_identifier', 'private_link',
    'source_identifier']) {
    assert.ok(exported.redacted.reasons[reason] > 0, `redaction reports ${reason}`);
  }
  assert.equal(exported.counts.recurringJobs, 0, 'a job whose terms were all dropped is omitted');

  const portable = JSON.stringify(exported.template);
  for (const secret of ['synthetic-secret', 'alice@example.com', 'C:\\\\synthetic', 'member-1',
    '127.0.0.1', 'synthetic0123456789abcdef']) {
    assert.equal(portable.includes(secret), false, `the template must not carry ${secret}`);
  }
  assert.match(portable, /\[redacted:/, 'the description keeps its meaning around a marker');

  const target = targetWorld(t);
  await callTeamTool(target.app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template: exported.template
  });
  const stored = JSON.stringify([...target.provider.state.agents.values()]);
  assert.equal(stored.includes('synthetic-secret'), false, 'the target never receives the secret');
  assert.equal(stored.includes('alice@example.com'), false);
});

test('a learned workflow travels as trigger, scope and checks, waiting for the target person', async (t) => {
  const source = sourceWorld(t, { learned: true });
  const exported = await callTeamTool(source.app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  const lesson = exported.template.workflows.find(workflow => workflow.name === 'Synthetic review lesson').lesson;
  assert.deepEqual(lesson, {
    trigger: 'Before a synthetic release is approved',
    scope: 'A synthetic build under review',
    checks: ['The synthetic risk list was read']
  }, 'only transferable parts of the lesson travel');

  const target = targetWorld(t);
  const preview = await callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template: exported.template
  });
  const imported = await callTeamTool(target.app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template: exported.template,
    confirmationDigest: preview.confirmationDigest
  });
  assert.equal(imported.status, 'imported');

  const reviewer = preview.roles.find(role => role.roleKey === 'reviewer');
  assert.ok(reviewer);
  const learned = target.workflows.overview({ personalSpaceId: SPACE, agentId: reviewer.agentId }).workflows
    .find(workflow => workflow.pending?.name === 'Synthetic review lesson');
  assert.ok(learned, 'the target team receives the proposed learned workflow');
  assert.equal(learned.status, 'proposed', 'a learned workflow is never active without the target person');
  assert.equal(learned.active, null);
  assert.equal(learned.pending.approval, undefined, 'the source person words do not travel');
  assert.equal(learned.pending.delivery, undefined, 'the source delivery does not travel');
  assert.deepEqual(learned.pending.lesson, {
    trigger: 'Before a synthetic release is approved',
    scope: 'A synthetic build under review',
    pitfalls: [],
    acceptanceEvidence: ['The synthetic risk list was read']
  });
  const { workflowId } = learned;
  const owner = { personalSpaceId: SPACE, personalProjectId: TARGET, agentId: reviewer.agentId };
  const elsewhere = { ...owner, personalProjectId: SOURCE };
  const peer = { ...owner, agentId: preview.lead.agentId };
  assert.equal(target.workflows.index(peer).lessons, undefined);
  assert.deepEqual(target.workflows.index(elsewhere).workflows, []);
  target.workflows.decide({ personalSpaceId: SPACE, workflowId, version: 1, decision: 'confirm' });
  assert.deepEqual(target.workflows.index(peer).lessons.map(item => item.workflowId), [workflowId]);
  assert.deepEqual(target.workflows.entryGrowth(peer).workflows.map(item => [item.workflowId, item.shared]), [[workflowId, true]]);
  assert.deepEqual(target.workflows.read(peer, { workflowId }).lesson, learned.pending.lesson);
  assert.throws(() => target.workflows.read(elsewhere, { workflowId }), { code: 'workflow_not_found' });
  assert.throws(() => target.workflows.recordRun(elsewhere, { workflowId, outcome: 'done' }), { code: 'workflow_not_found' });
});

test('preview maps roles and writes nothing; a stale digest is refused but a clear instruction imports', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = targetWorld(t);
  const before = { agents: target.provider.state.agents.size, policies: target.provider.state.policies.size,
    workflows: target.workflows.listSpace({ personalSpaceId: SPACE }).length,
    assignments: target.assignments.list(SPACE).length };

  const preview = await callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(preview.status, 'ready');
  assert.match(preview.confirmationDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(preview.roles.map(role => role.action), ['create', 'create', 'create']);
  assert.deepEqual(preview.workflows.map(workflow => workflow.action), ['propose']);
  assert.deepEqual(preview.recurringJobs.map(job => job.action), ['draft']);
  assert.equal(preview.templateDraft.action, 'draft', 'the checks and lines are drafted, never enabled');
  assert.equal(preview.policy.action, 'update');

  assert.deepEqual({ agents: target.provider.state.agents.size, policies: target.provider.state.policies.size,
    workflows: target.workflows.listSpace({ personalSpaceId: SPACE }).length,
    assignments: target.assignments.list(SPACE).length }, before, 'preview must write nothing');

  const stale = `${preview.confirmationDigest.slice(0, 63)}0`;
  await assert.rejects(callTeamTool(target.app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template, confirmationDigest: stale
  }), { code: 'team_template_confirmation_required' });
  assert.deepEqual({ agents: target.provider.state.agents.size, policies: target.provider.state.policies.size,
    workflows: target.workflows.listSpace({ personalSpaceId: SPACE }).length,
    assignments: target.assignments.list(SPACE).length }, before, 'a refused import writes nothing');
});

test('team preview identifies invalid role mappings by field without echoing the supplied key', async (t) => {
  const template = await exportedTemplate(sourceWorld(t).app);
  const { app } = targetWorld(t);
  const preview = roleAgentIds => callTeamTool(app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template, roleAgentIds
  });
  await assert.rejects(preview({ 'unknown-test-role': 'agent' }), { code: 'invalid_input',
    message: 'roleAgentIds contains an unknown role key' });
  await assert.rejects(preview({ [template.roles[0].roleKey]: '' }), { code: 'invalid_input',
    message: 'roleAgentIds agent ID is required' });
});

test('an import builds a working team the normal team port can read; a retry adds nothing twice', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = targetWorld(t);
  const { app, provider, workflows, assignments } = target;

  const preview = await callTeamTool(app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  // The person's instruction already names this destination: no second approval.
  const imported = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template, confirmationDigest: preview.confirmationDigest
  });

  assert.equal(imported.status, 'imported');
  assert.deepEqual(imported.counts, {
    agentsCreated: 3, agentsReused: 0, assignmentsCreated: 3, assignmentsReused: 0,
    policyChanged: true, workflowsProposed: 1, workflowsKept: 0,
    recurringJobsDrafted: 1, recurringJobsUnchanged: 0, recurringJobsKept: 0
  });
  assert.equal(imported.acceptance.length, 0);
  assert.equal(imported.templateDraft.action, 'draft');
  assert.equal(imported.applied.templateDraft, 'drafted');

  const policy = await provider.getProjectAgentCoordinationPolicy(SPACE, TARGET);
  assert.equal(policy.team_lead_agent_id, preview.lead.agentId);
  assert.equal(policy.team_member_agent_ids.length, 2);
  assert.equal(policy.ask_before_recruitment, false, 'a new project keeps its own switch, not the source\'s');
  assert.equal(policy.auto_reuse_previous_agent, true);

  // The normal team port reads the imported division of work.
  const team = await app.getProjectTeam({ personalSpaceId: SPACE, personalProjectId: TARGET });
  assert.equal(team.status, 'ready');
  assert.equal(team.lead.agentId, preview.lead.agentId);
  assert.deepEqual(team.members.map(member => member.occupation).sort(), ['builder', 'reviewer']);
  assert.deepEqual(team.members.map(member => member.agentId).sort(),
    preview.roles.filter(role => role.roleKey !== 'planner').map(role => role.agentId).sort());
  assert.equal(team.workstreams.length, 0,
    'the recurring blueprint is a draft, so it is not a workstream that routes new work');
  assert.equal(team.importedTeamTemplate.status, 'draft', 'the team read names the imported draft');

  const builder = preview.roles.find(role => role.roleKey === 'builder');
  assert.ok(builder);
  const targetAgent = await provider.getProjectAgent(SPACE, TARGET, builder.agentId);
  assert.equal(targetAgent.occupation.role, 'builder');
  assert.equal(targetAgent.profile.responsibility, 'Build the synthetic thing');
  assert.deepEqual(targetAgent.assignments.map(item => item.personal_project_id), [TARGET]);

  const [proposed] = workflows.overview({ personalSpaceId: SPACE, agentId: builder.agentId }).workflows;
  assert.equal(proposed.status, 'proposed', 'an import never confirms a workflow for the person');
  assert.equal(proposed.active, null);
  assert.equal(proposed.pending.source, workflowSourceOf(TARGET, 'builder', 'Synthetic release check'));

  const targetLines = assignments.list(SPACE).filter(item => item.projectId === TARGET);
  assert.equal(targetLines.length, 0,
    'an imported recurring blueprint is a draft, never a standing line that would route new work');
  assert.equal(provider.state.assignments.size, 3, 'one assignment per role');
  assert.equal(provider.state.agents.size, 3, 'one Agent per template role; the outsider stays behind');

  // The same template and project again, with no digest: every saved part is reused.
  const again = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(again.status, 'imported');
  assert.deepEqual(again.counts, {
    agentsCreated: 0, agentsReused: 3, assignmentsCreated: 0, assignmentsReused: 3,
    policyChanged: false, workflowsProposed: 0, workflowsKept: 0,
    recurringJobsDrafted: 0, recurringJobsUnchanged: 1, recurringJobsKept: 0
  });
  assert.equal(provider.state.agents.size, 3);
  assert.equal(assignments.list(SPACE).filter(item => item.projectId === TARGET).length, 0);
  assert.equal(workflows.overview({ personalSpaceId: SPACE, agentId: builder.agentId }).workflows.length, 1);
  assert.deepEqual(await app.getProjectTeam({ personalSpaceId: SPACE, personalProjectId: TARGET }), team,
    'a retry changes nothing the team port reads');
});

test('concurrent imports add one role, one workflow and one line per job, never duplicates', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = targetWorld(t);
  const { app, provider, workflows, assignments } = target;

  const results = await Promise.all([
    callTeamTool(app, 'import_project_team_template', { personalSpaceId: SPACE, personalProjectId: TARGET, template }),
    callTeamTool(app, 'import_project_team_template', { personalSpaceId: SPACE, personalProjectId: TARGET, template })
  ]);
  for (const result of results) assert.ok(['imported', 'partial'].includes(result.status));
  // One request may lose the policy revision race; a retry finishes it.
  await callTeamTool(app, 'import_project_team_template', { personalSpaceId: SPACE, personalProjectId: TARGET, template });

  assert.equal(provider.state.agents.size, 3);
  assert.equal([...provider.state.agents.values()].filter(agent => agent.assignments?.length
    && agent.assignments.some(item => item.personal_project_id === TARGET)).length, 3);
  assert.equal(provider.state.assignments.size, 3, 'one assignment per role');
  assert.equal(assignments.list(SPACE).filter(item => item.projectId === TARGET).length, 0,
    'no standing line is created by a concurrent retry either');
  const builder = (await provider.getProjectAgentCoordinationPolicy(SPACE, TARGET));
  const builderId = builder.team_member_agent_ids.find(id => id !== builder.team_lead_agent_id);
  assert.ok(builderId);
  assert.equal(workflows.listSpace({ personalSpaceId: SPACE }).filter(workflow =>
    workflow.personalProjectId === TARGET).length, 1);
  assert.equal(target.receipts.read(SPACE, TARGET).recurringBlueprints.length, 1,
    'concurrency leaves exactly one draft blueprint');
});

test('a partial failure keeps what it saved and a retry finishes without duplicates', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = targetWorld(t);
  const { app, provider, workflows, assignments } = target;

  const preview = await callTeamTool(app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  const builderId = preview.roles.find(role => role.roleKey === 'builder').agentId;
  const original = provider.createProjectAgentAssignment.bind(provider);
  let failed = false;
  provider.createProjectAgentAssignment = async (input) => {
    if (!failed && input.agent_id === builderId) {
      failed = true;
      throw Object.assign(new Error('Synthetic assignment failure'), { code: 'synthetic_failure' });
    }
    return original(input);
  };

  const partial = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template, confirmationDigest: preview.confirmationDigest
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.retryable, true);
  assert.equal(partial.failure.code, 'synthetic_failure');
  assert.equal(partial.counts.agentsCreated, 2, 'the Agents before the failure were saved');
  assert.equal(provider.state.assignments.size, 1,
    'the failed assignment and the ones after it are not saved');

  const retried = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(retried.status, 'imported');
  assert.deepEqual(retried.counts, {
    agentsCreated: 1, agentsReused: 2, assignmentsCreated: 2, assignmentsReused: 1,
    policyChanged: true, workflowsProposed: 1, workflowsKept: 0,
    recurringJobsDrafted: 1, recurringJobsUnchanged: 0, recurringJobsKept: 0
  });
  assert.equal(provider.state.agents.size, 3);
  assert.equal(provider.state.assignments.size, 3, 'the retry saves the missing assignments only');
  assert.equal((await app.getProjectTeam({ personalSpaceId: SPACE, personalProjectId: TARGET })).members.length, 2);
  assert.equal(assignments.list(SPACE).filter(item => item.projectId === TARGET).length, 0);
  assert.equal(workflows.listSpace({ personalSpaceId: SPACE }).length, 1);
});

test('only active work travels: a proposal and outside lines stay behind', async (t) => {
  const source = sourceWorld(t, { inactive: true });
  const result = await callTeamTool(source.app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  assert.deepEqual(result.template.workflows.map(workflow => workflow.name), ['Synthetic release check']);
  assert.deepEqual(result.template.recurringJobs.map(job => job.roleKey), ['builder']);
});

test('a target with another working lead is reported as a conflict and never replaced', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = targetWorld(t);
  const { app, provider, workflows, assignments } = target;
  provider.state.agents.set('target-lead', agent({ id: 'target-lead', occupation: 'manager',
    responsibility: 'Lead the synthetic target',
    assignments: [assignment({ projectId: TARGET, agentId: 'target-lead', responsibility: 'Lead the synthetic target' })] }));
  provider.state.policies.set(TARGET, {
    personal_space_id: SPACE, personal_project_id: TARGET,
    team_lead_agent_id: 'target-lead', team_member_agent_ids: [], sub_teams: [],
    sub_team_suggestion_threshold: 6, updated_at: '2026-03-01T00:00:00.000Z'
  });
  const before = { agents: provider.state.agents.size, policy: provider.state.policies.get(TARGET),
    assignments: assignments.list(SPACE).length };

  const preview = await callTeamTool(app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(preview.status, 'conflict');
  assert.ok(preview.conflicts.some(conflict => conflict.code === 'team_template_target_lead_conflict'));

  const applied = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template,
    confirmationDigest: preview.confirmationDigest
  });
  assert.equal(applied.status, 'conflict');
  assert.deepEqual({ agents: provider.state.agents.size, policy: provider.state.policies.get(TARGET),
    assignments: assignments.list(SPACE).length }, before, 'a refused import writes nothing');
  assert.equal(workflows.listSpace({ personalSpaceId: SPACE }).length, 0);
});

test('a reimport keeps a workflow the target changed after the first import', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = targetWorld(t);
  const { app, provider, workflows } = target;
  const imported = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(imported.status, 'imported');
  const builderId = (await callTeamTool(app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  })).roles.find(role => role.roleKey === 'builder').agentId;

  const [original] = workflows.overview({ personalSpaceId: SPACE, agentId: builderId }).workflows;
  workflows.propose({ personalSpaceId: SPACE, agentId: builderId, personalProjectId: TARGET }, {
    workflowId: original.workflowId, name: 'Synthetic release check, changed here',
    purpose: original.pending.purpose, steps: original.pending.steps, source: 'agent'
  });

  const preview = await callTeamTool(app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.deepEqual(preview.workflows.map(workflow => workflow.action), ['kept']);
  assert.deepEqual(preview.recurringJobs.map(job => job.action), ['unchanged'],
    'an unchanged draft is reported as unchanged, not rewritten');

  const again = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(again.status, 'imported');
  assert.deepEqual([again.counts.workflowsProposed, again.counts.workflowsKept,
    again.counts.recurringJobsDrafted, again.counts.recurringJobsKept], [0, 1, 0, 0]);

  const [kept] = workflows.overview({ personalSpaceId: SPACE, agentId: builderId }).workflows;
  assert.equal(kept.pending.name, 'Synthetic release check, changed here', 'the local change is not overwritten');
});

test('concurrent imports preserve ordinary and learned workflow edits, rejected proposals and retired copies', async (t) => {
  const source = sourceWorld(t, { learned: true });
  const template = await exportedTemplate(source.app);
  // Staff the target first, so two imports can reach the workflow writes
  // together without either losing an earlier coordination-policy write.
  for (const { workflowId } of source.workflows.listSpace({ personalSpaceId: SPACE })) {
    source.workflows.decide({ personalSpaceId: SPACE, workflowId, decision: 'retire', version: 1 });
  }
  const { app, workflows } = targetWorld(t);
  const input = { personalSpaceId: SPACE, personalProjectId: TARGET, template };
  const apply = () => callTeamTool(app, 'import_project_team_template', input);
  const preview = () => callTeamTool(app, 'preview_project_team_template_import', input);
  const setup = await callTeamTool(app, 'import_project_team_template', { ...input, template: await exportedTemplate(source.app) });
  assert.equal(setup.status, 'imported');
  const concurrent = await Promise.all([apply(), apply()]);
  assert.ok(concurrent.every(result => result.status === 'imported'));
  assert.equal(concurrent.reduce((total, result) => total + result.counts.workflowsProposed, 0), 2);
  const copies = workflows.listSpace({ personalSpaceId: SPACE });
  assert.equal(copies.length, 2);
  const [ordinary, learned] = template.workflows.map(item => copies.find(copy => copy.name === item.name));
  const decide = (copy, decision, version) => workflows.decide({ personalSpaceId: SPACE,
    workflowId: copy.workflowId, decision, version });
  const edit = copy => workflows.propose({ personalSpaceId: SPACE, personalProjectId: TARGET, agentId: copy.agentId }, {
    workflowId: copy.workflowId, name: 'Edited here', purpose: 'Local work', steps: [{ title: 'Local check' }], source: 'agent'
  });
  decide(ordinary, 'reject', 1);
  decide(learned, 'confirm', 1);
  edit(learned);
  const before = () => copies.map(copy => workflows.overview({ personalSpaceId: SPACE, agentId: copy.agentId }).workflows);
  const verifyKept = async () => {
    const saved = before();
    assert.deepEqual((await preview()).workflows.map(item => item.action), ['kept', 'kept']);
    const [first, second] = await Promise.all([apply(), apply()]);
    for (const result of [first, second]) {
      assert.equal(result.status, 'imported');
      assert.deepEqual(result.applied.workflows, { proposed: [], kept: template.workflows.map(item => item.name), unchanged: [] });
    }
    assert.deepEqual(before(), saved);
  };
  await verifyKept();
  decide(learned, 'reject', 2);
  await verifyKept();
  edit(learned);
  decide(learned, 'confirm', 3);
  await verifyKept();
  decide(learned, 'retire', 3);
  await verifyKept();
});

test('unrelated target work survives the import and the target team is never rewritten', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = targetWorld(t);
  const { app, provider, workflows, assignments } = target;

  await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  const leadId = (await app.getProjectTeam({ personalSpaceId: SPACE, personalProjectId: TARGET })).lead.agentId;
  workflows.propose({ personalSpaceId: SPACE, agentId: leadId, personalProjectId: TARGET }, {
    name: 'Unrelated target workflow', purpose: 'Work the target already had', steps: [{ title: 'Keep me' }],
    source: 'agent'
  });
  assignments.register({ personalSpaceId: SPACE, projectId: TARGET, leadAgentId: 'target-helper',
    terms: ['unrelated target work'], responsibility: 'An unrelated target line', preferenceIds: [],
    source: 'user', sourceConversationId: null });

  const again = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(again.status, 'imported');
  assert.equal(again.counts.agentsCreated, 0);
  assert.equal(again.counts.assignmentsCreated, 0);
  assert.equal(workflows.listSpace({ personalSpaceId: SPACE })
    .some(workflow => workflow.name === 'Unrelated target workflow'), true);
  assert.equal(assignments.list(SPACE).some(item => item.responsibility === 'An unrelated target line'), true);
  assert.equal(provider.state.agents.size, 3);
});

test('imported checks and blueprints survive a restart as drafts that route nothing', async (t) => {
  const source = sourceWorld(t, { checks: true });
  const exported = await callTeamTool(source.app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  assert.equal(exported.counts.acceptance, 1);
  assert.equal(exported.template.acceptance[0].occupation, 'builder');

  const target = targetWorld(t);
  const preview = await callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template: exported.template
  });
  assert.equal(preview.templateDraft.action, 'draft');
  assert.deepEqual(preview.acceptance.map(check => check.status), ['draft']);
  assert.deepEqual(preview.acceptance.map(check => check.action), ['draft']);

  const imported = await callTeamTool(target.app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template: exported.template,
    confirmationDigest: preview.confirmationDigest
  });
  assert.equal(imported.status, 'imported');
  assert.equal(imported.counts.recurringJobsDrafted, 1);
  assert.equal(imported.applied.templateDraft, 'drafted');

  // A new session on the same computer: new stores over the same local data
  // directory, exactly as a restart reads them.
  const reopened = world(t, {
    projects: [{ projectId: TARGET, profile: { name: 'Synthetic target' } }],
    receiptsDirectory: target.receiptsDirectory
  });
  const team = await reopened.app.getProjectTeam({ personalSpaceId: SPACE, personalProjectId: TARGET });
  assert.equal(team.importedTeamTemplate.status, 'draft');
  assert.equal(team.importedTeamTemplate.acceptance, 1);
  assert.equal(team.importedTeamTemplate.recurringBlueprints, 1);
  assert.equal(team.importedTeamTemplate.readWith, 'read_project_team_template');

  const draft = await callTeamTool(reopened.app, 'read_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET
  });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.acceptance.total, 1);
  assert.equal(draft.acceptance.items[0].text, 'The synthetic build passes its release check');
  assert.equal(draft.acceptance.items[0].occupation, 'builder');
  assert.equal(draft.recurringBlueprints.total, 1);
  assert.deepEqual(draft.recurringBlueprints.items[0].terms, ['synthetic release']);
  assert.match(draft.next, /Nothing here runs or routes work/);

  // Reading changed nothing: still no standing line and no active workflow.
  assert.equal(reopened.assignments.list(SPACE).filter(item => item.projectId === TARGET).length, 0);
  assert.equal(reopened.workflows.listSpace({ personalSpaceId: SPACE })
    .filter(workflow => workflow.personalProjectId === TARGET).length, 0);
});

test('a source change never overwrites the draft a target already received', async (t) => {
  const source = sourceWorld(t, { checks: true });
  const first = await callTeamTool(source.app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  const target = targetWorld(t);
  const imported = await callTeamTool(target.app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template: first.template
  });
  assert.equal(imported.status, 'imported');
  const receipt = target.receipts.read(SPACE, TARGET);
  assert.deepEqual(receipt.acceptance.map(check => check.text),
    ['The synthetic build passes its release check']);

  // The target person keeps their own acceptance check; an import never
  // replaces it with the source's.
  target.provider.state.experiences = [{
    id: 'target-check', projectId: TARGET, agentId: 'target-helper', kind: 'acceptance_item',
    text: 'The target keeps its own human acceptance'
  }];

  // The source moves on: another kept check and another release term reach the
  // target as a newer template.
  source.provider.state.experiences = [{
    id: 'check-2', projectId: SOURCE, agentId: 'member-1', kind: 'acceptance_item',
    text: 'The changed synthetic build passes a new release check'
  }];
  const [sourceLine] = source.assignments.list(SPACE).filter(item => item.projectId === SOURCE);
  source.assignments.correct(sourceLine.assignmentId,
    { action: 'edit_terms', addTerms: ['synthetic release v2'], removeTerms: [] },
    { expectedRevision: sourceLine.revision, source: 'user' });
  const newer = await callTeamTool(source.app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  assert.notEqual(newer.templateId, first.templateId);

  const preview = await callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template: newer.template
  });
  assert.equal(preview.templateDraft.action, 'kept');
  assert.deepEqual(preview.acceptance.map(check => check.action), ['kept']);
  assert.deepEqual(preview.recurringJobs.map(job => job.action), ['kept']);

  const again = await callTeamTool(target.app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template: newer.template
  });
  assert.equal(again.status, 'imported');
  assert.equal(again.templateDraft.action, 'kept');
  assert.deepEqual([again.counts.recurringJobsDrafted, again.counts.recurringJobsKept], [0, 1]);

  const after = target.receipts.read(SPACE, TARGET);
  assert.deepEqual(after.acceptance.map(check => check.text),
    ['The synthetic build passes its release check'], 'the first draft is not overwritten');
  assert.deepEqual(after.recurringBlueprints.map(item => item.terms), [['synthetic release']]);
  assert.equal(after.templateId, first.templateId);
  assert.deepEqual(target.provider.state.experiences.map(check => check.text),
    ['The target keeps its own human acceptance'], 'the target\'s own acceptance is untouched');
});

test('a source Agent named after its generic role still transfers that role', async (t) => {
  const source = world(t, {
    projects: [{ projectId: SOURCE, profile: { name: 'Synthetic source' } }],
    agents: [agent({ id: 'engineering', occupation: 'engineering',
      responsibility: 'Ship the engineering synthetic build',
      assignments: [assignment({ projectId: SOURCE, agentId: 'engineering',
        responsibility: 'Ship the engineering synthetic build' })] })]
  });
  source.provider.state.policies.set(SOURCE, {
    personal_space_id: SPACE, personal_project_id: SOURCE, team_lead_agent_id: 'engineering',
    team_member_agent_ids: [], sub_teams: [], sub_team_suggestion_threshold: 6,
    updated_at: '2026-02-01T00:00:00.000Z'
  });
  const result = await callTeamTool(source.app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  assert.deepEqual(result.template.roles.map(role => role.roleKey), ['engineering']);
  assert.equal(result.template.roles[0].occupation.role, 'engineering');
  assert.equal(result.template.roles[0].responsibility, 'Ship the engineering synthetic build',
    'the role name is not mistaken for a source identifier');
  assert.equal(result.template.relationships.leadRoleKey, 'engineering');

  const target = targetWorld(t);
  const imported = await callTeamTool(target.app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template: result.template
  });
  assert.equal(imported.status, 'imported');
  const team = await target.app.getProjectTeam({ personalSpaceId: SPACE, personalProjectId: TARGET });
  assert.equal(team.lead.occupation, 'engineering');
  assert.deepEqual(team.members, []);
});

test('all four team template tools reject a task bound to another project', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = targetWorld(t);
  const targetToken = taskTokenFor(TARGET);
  const sourceToken = taskTokenFor(SOURCE);

  // The target's task names the source: no provider read, no reference lookup
  // and no write before the mismatch is refused.
  const requests = [
    ['export_project_team_template', { personalSpaceId: SPACE, personalProjectId: SOURCE }],
    ['preview_project_team_template_import', { personalSpaceId: SPACE, personalProjectId: SOURCE, template }],
    ['import_project_team_template', { personalSpaceId: SPACE, personalProjectId: SOURCE, template }],
    ['read_project_team_template', { personalSpaceId: SPACE, personalProjectId: SOURCE }]
  ];
  for (const [name, input] of requests) {
    await assert.rejects(callTeamTool(target.app, name, input, targetToken), { code: 'project_mismatch' },
      `${name} refuses a task that works in the target while naming the source`);
  }
  assert.equal(target.provider.state.agents.size, 0, 'a refused import writes no Agent');
  assert.equal(target.assignments.list(SPACE).length, 0, 'a refused import writes no standing line');
  assert.equal(target.workflows.listSpace({ personalSpaceId: SPACE }).length, 0);
  assert.equal(target.receipts.read(SPACE, SOURCE), null, 'a refused call creates no receipt');
  assert.equal(target.receipts.read(SPACE, TARGET), null);

  // A same-space transfer is two independently authorized calls: export under
  // the source task, then preview/import/read under the target task.
  const exported = await callTeamTool(source.app, 'export_project_team_template',
    { personalSpaceId: SPACE, personalProjectId: SOURCE }, sourceToken);
  assert.equal(exported.status, 'exported');
  const preview = await callTeamTool(target.app, 'preview_project_team_template_import',
    { personalSpaceId: SPACE, personalProjectId: TARGET, template: exported.template }, targetToken);
  assert.equal(preview.status, 'ready');
  const imported = await callTeamTool(target.app, 'import_project_team_template',
    { personalSpaceId: SPACE, personalProjectId: TARGET, template: exported.template,
      confirmationDigest: preview.confirmationDigest }, targetToken);
  assert.equal(imported.status, 'imported');
  const draft = await callTeamTool(target.app, 'read_project_team_template',
    { personalSpaceId: SPACE, personalProjectId: TARGET }, targetToken);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.recurringBlueprints.total, 1);

  // The source task cannot act for the target either.
  await assert.rejects(callTeamTool(target.app, 'read_project_team_template',
    { personalSpaceId: SPACE, personalProjectId: TARGET }, sourceToken), { code: 'project_mismatch' });
});

test('every team template tool requires the taskContextToken', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = targetWorld(t);
  const requests = [
    ['export_project_team_template', { personalSpaceId: SPACE, personalProjectId: TARGET }],
    ['preview_project_team_template_import', { personalSpaceId: SPACE, personalProjectId: TARGET, template }],
    ['import_project_team_template', { personalSpaceId: SPACE, personalProjectId: TARGET, template }],
    ['read_project_team_template', { personalSpaceId: SPACE, personalProjectId: TARGET }]
  ];
  for (const [name, input] of requests) {
    await assert.rejects(callAgentTool(target.app, name, input),
      error => error.code === 'invalid_input' && /taskContextToken/.test(error.message),
      `${name} refuses a call with no taskContextToken`);
  }
});

test('pruning a template reference removes only its own ttr-<32 hex>.json records', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-team-refs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const now = new Date('2026-03-01T00:00:00.000Z');
  const refs = createTeamTemplateRefs({ directory, now: () => now });
  // Unrelated files in the same directory belong to the person or another store.
  writeFileSync(join(directory, 'notes.json'), '{"keep":true}\n');
  writeFileSync(join(directory, 'ttr-not-a-hex-name.json'), '{"keep":true}\n');
  const expiredPath = join(directory, 'ttr-00000000000000000000000000000000.json');
  writeFileSync(expiredPath, '{}\n');
  const old = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(expiredPath, old, old);

  refs.put({ templateId: 'a'.repeat(64) }, { personalSpaceId: SPACE, sourcePersonalProjectId: SOURCE });

  assert.equal(existsSync(expiredPath), false, 'an expired reference of this feature is pruned');
  assert.equal(readFileSync(join(directory, 'notes.json'), 'utf8'), '{"keep":true}\n',
    'an unrelated JSON file is never removed');
  assert.equal(readFileSync(join(directory, 'ttr-not-a-hex-name.json'), 'utf8'), '{"keep":true}\n',
    'a lookalike name is never removed');
  assert.equal(readdirSync(directory).filter(name => /^ttr-[0-9a-f]{32}\.json$/.test(name)).length, 1,
    'the new reference is kept');
});

test('a local reference round-trips the template to preview and import on this computer', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-team-template-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const refs = createTeamTemplateRefs({ directory });
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const exported = await callTeamTool(source.app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  assert.equal(exported.template.templateId, template.templateId);

  const ref = refs.put(template, { personalSpaceId: SPACE, sourcePersonalProjectId: SOURCE });
  assert.match(ref, /^ttr-[0-9a-f]{32}$/);
  assert.deepEqual(refs.get(ref, { personalSpaceId: SPACE }), template);
  assert.throws(() => refs.get(ref, { personalSpaceId: 'space-other' }),
    { code: 'team_template_reference_not_found' });
  assert.throws(() => refs.get('ttr-00000000000000000000000000000000', { personalSpaceId: SPACE }),
    { code: 'team_template_reference_not_found' });

  const target = targetWorld(t, { refs });
  const preview = await callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, templateRef: ref
  });
  assert.equal(preview.status, 'ready');
  const imported = await callTeamTool(target.app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, templateRef: ref
  });
  assert.equal(imported.status, 'imported');
  assert.deepEqual(imported.counts.agentsCreated, 3);
});

test('a small team stays inline; a team too large for one answer travels as a reference', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-team-template-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const refs = createTeamTemplateRefs({ directory });

  const small = world(t, {
    projects: [{ projectId: SOURCE, profile: { name: 'Synthetic source' } }],
    agents: [agent({ id: 'sole-lead', occupation: 'planner', responsibility: 'Plan the synthetic work',
      assignments: [assignment({ projectId: SOURCE, agentId: 'sole-lead',
        responsibility: 'Plan the synthetic work' })] })],
    refs
  });
  small.provider.state.policies.set(SOURCE, {
    personal_space_id: SPACE, personal_project_id: SOURCE, team_lead_agent_id: 'sole-lead',
    team_member_agent_ids: [], sub_teams: [], sub_team_suggestion_threshold: 6,
    updated_at: '2026-02-01T00:00:00.000Z'
  });
  const inline = await callTeamTool(small.app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  assert.ok(inline.template, 'a small team travels inline even when this computer can keep a reference');
  assert.equal(inline.templateRef, undefined, 'a small team keeps no local reference');
  assert.equal(readdirSync(directory).length, 0, 'an inline export writes no file');

  // A team whose descriptions do not fit one answer is kept and referenced.
  const long = 'Build the synthetic component and check it.'.padEnd(4096, 'x');
  const occupations = ['planner', 'builder', 'reviewer', 'designer', 'operator'];
  const large = world(t, {
    projects: [{ projectId: SOURCE, profile: { name: 'Synthetic source' } }],
    agents: occupations.map((occupation, index) => agent({ id: `large-${index}`, occupation, responsibility: long,
      assignments: [assignment({ projectId: SOURCE, agentId: `large-${index}`, responsibility: long })] })),
    refs
  });
  large.provider.state.policies.set(SOURCE, {
    personal_space_id: SPACE, personal_project_id: SOURCE, team_lead_agent_id: 'large-0',
    team_member_agent_ids: ['large-1', 'large-2', 'large-3', 'large-4'], sub_teams: [],
    sub_team_suggestion_threshold: 6, updated_at: '2026-02-01T00:00:00.000Z'
  });
  const exported = await callTeamTool(large.app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  assert.equal(exported.template, undefined, 'a template over the inline limit is not cut into the answer');
  assert.match(exported.templateRef, /^ttr-[0-9a-f]{32}$/);
  assert.equal(exported.counts.roles, 5);
  const kept = refs.get(exported.templateRef, { personalSpaceId: SPACE });
  assert.equal(kept.templateId, exported.templateId);
  assert.equal(readdirSync(directory).filter(name => name.endsWith('.json')).length, 1,
    'only a too-large export is kept');
});

test('exactly one template source is required', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = targetWorld(t);
  await assert.rejects(callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET
  }), { code: 'invalid_input' });
  await assert.rejects(callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template, templateRef: 'ttr-00000000000000000000000000000000'
  }), { code: 'invalid_input' });
});

test('a foreign project or space never selects another project', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = targetWorld(t);

  await assert.rejects(callTeamTool(target.app, 'export_project_team_template', {
    personalSpaceId: 'space-other', personalProjectId: SOURCE
  }), { code: 'scope_mismatch' });
  await assert.rejects(callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: 'space-other', personalProjectId: TARGET, template
  }), { code: 'scope_mismatch' });

  const foreign = await callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: 'project-elsewhere', template
  });
  assert.equal(foreign.status, 'conflict');
  assert.ok(foreign.conflicts.some(conflict => conflict.code === 'team_template_project_not_found'));
  const applied = await callTeamTool(target.app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: 'project-elsewhere', template
  });
  assert.equal(applied.status, 'conflict');
  assert.equal(target.provider.state.agents.size, 0);
});
