import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createTeamTemplateReceipts } from '../src/team-templates/receipts.js';

import {
  BOOTSTRAP_REASON, SPACE, SOURCE, TARGET,
  agent, assignment, bootstrapTarget, callTeamTool, exportedTemplate, sourceWorld, targetWorld, world
} from './fixtures/project-team-template.js';

// A normal entry staffs a default project lead on the target's first task,
// before a person can preview an import. These tests cover the three narrow
// cases that decides: the untouched bootstrap lead fills the template lead
// seat, a specialized source lead still binds to that seat, and anything a
// person set or changed keeps the ordinary lead-conflict protection.

test('the normal entry\'s automatically staffed lead fills the template lead seat and is reused on retry', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = bootstrapTarget(t);
  const { app, provider } = target;
  // The bootstrap Agent has its own profile, credentials and access. Filling
  // the lead seat must not rewrite any of them.
  target.lead.profile.character = { judgment: 'Keep the project context', taste: '', personality: '' };
  target.lead.profile.allowed_clients = ['opencode'];
  target.lead.executor_policy = { mode: 'locked', locked_executor_ids: ['executor-own'] };
  const leadBefore = structuredClone(target.lead);

  const preview = await callTeamTool(app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.lead.agentId, 'auto-lead', 'the existing automatically staffed lead fills the seat');
  assert.equal(preview.lead.seat, 'adopted');
  assert.equal(preview.lead.occupation, 'lead');
  assert.equal(preview.policy.leadSeat, 'adopted');
  const planner = preview.roles.find(role => role.roleKey === 'planner');
  assert.deepEqual([planner.agentId, planner.action, planner.assignment], ['auto-lead', 'reuse', 'reuse'],
    'the template lead role reuses the bootstrap Agent and its one assignment');
  assert.deepEqual(preview.templateDraft.leadSeat, { roleKey: 'planner', agentId: 'auto-lead' });
  assert.equal(provider.state.agents.size, 1, 'preview writes nothing');

  const imported = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template,
    confirmationDigest: preview.confirmationDigest
  });
  assert.equal(imported.status, 'imported');
  assert.deepEqual(imported.counts, {
    agentsCreated: 2, agentsReused: 1, assignmentsCreated: 2, assignmentsReused: 1,
    policyChanged: true, workflowsProposed: 1, workflowsKept: 0,
    recurringJobsDrafted: 1, recurringJobsUnchanged: 0, recurringJobsKept: 0
  });
  assert.deepEqual(provider.state.agents.get('auto-lead'), leadBefore,
    'the lead keeps its identity, profile, occupation, credentials and access');
  assert.equal(provider.state.agents.size, 3, 'the other two roles are created; no second lead Agent');
  assert.equal(provider.state.assignments.size, 3, 'the bootstrap assignment is reused, never duplicated');

  const policy = await provider.getProjectAgentCoordinationPolicy(SPACE, TARGET);
  assert.equal(policy.team_lead_agent_id, 'auto-lead');
  assert.equal(policy.team_member_agent_ids.length, 2);

  const team = await app.getProjectTeam({ personalSpaceId: SPACE, personalProjectId: TARGET });
  assert.equal(team.lead.agentId, 'auto-lead');
  assert.equal(team.lead.occupation, 'lead', 'the target keeps its own locked lead occupation');
  assert.deepEqual(team.importedTeamTemplate.leadSeat,
    { roleKey: 'planner', agentId: 'auto-lead', occupation: 'planner' });

  // The template lead's portable role and responsibility survive a restart as
  // the target's own draft, since the Agent itself was not rewritten.
  const draft = await callTeamTool(app, 'read_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET
  });
  assert.equal(draft.leadSeat.roleKey, 'planner');
  assert.equal(draft.leadSeat.agentId, 'auto-lead');
  assert.equal(draft.leadSeat.occupation, 'planner');
  assert.equal(draft.leadSeat.responsibility, 'Plan the synthetic work');
  assert.match(draft.leadSeat.note, /not changed/);

  // A retry reuses the same seat: same deterministic import identity, no new
  // lead, assignment or policy rewrite.
  const again = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(again.status, 'imported');
  assert.deepEqual(again.counts, {
    agentsCreated: 0, agentsReused: 3, assignmentsCreated: 0, assignmentsReused: 3,
    policyChanged: false, workflowsProposed: 0, workflowsKept: 0,
    recurringJobsDrafted: 0, recurringJobsUnchanged: 1, recurringJobsKept: 0
  });
  assert.equal(again.lead.agentId, 'auto-lead');
  assert.equal(again.lead.seat, 'adopted');
  assert.equal(again.templateDraft.action, 'unchanged');
  assert.deepEqual(provider.state.agents.get('auto-lead'), leadBefore);
  assert.equal(provider.state.assignments.size, 3);
});

test('a specialized source lead binds to the bootstrap seat without weakening an ordinary member check', async (t) => {
  // The real source lead is often an engineering role while the target's
  // automatic lead is the generic lead occupation.
  const source = world(t, {
    projects: [{ projectId: SOURCE, profile: { name: 'Synthetic source' } }],
    agents: [
      agent({ id: 'engineering-lead', occupation: 'engineering',
        responsibility: 'Ship the engineering synthetic build',
        assignments: [assignment({ projectId: SOURCE, agentId: 'engineering-lead',
          responsibility: 'Ship the engineering synthetic build' })] }),
      agent({ id: 'builder-1', occupation: 'builder', responsibility: 'Build the synthetic thing',
        assignments: [assignment({ projectId: SOURCE, agentId: 'builder-1',
          responsibility: 'Build the synthetic thing' })] })
    ]
  });
  source.provider.state.policies.set(SOURCE, {
    personal_space_id: SPACE, personal_project_id: SOURCE, team_lead_agent_id: 'engineering-lead',
    team_member_agent_ids: ['builder-1'], sub_teams: [], sub_team_suggestion_threshold: 6,
    updated_at: '2026-02-01T00:00:00.000Z'
  });
  const exported = await callTeamTool(source.app, 'export_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: SOURCE
  });
  assert.equal(exported.status, 'exported');
  const template = exported.template;
  assert.equal(template.roles.find(role => role.roleKey === 'engineering').occupation.role, 'engineering');

  const target = bootstrapTarget(t);
  const preview = await callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(preview.status, 'ready', 'a different specialized lead occupation does not block the seat');
  assert.deepEqual(preview.conflicts, []);
  assert.equal(preview.lead.agentId, 'auto-lead');
  assert.equal(preview.lead.seat, 'adopted');

  // An ordinary member mapping is still checked: the bootstrap lead has the
  // lead occupation, not the member's.
  const mappedMember = await callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template, roleAgentIds: { builder: 'auto-lead' }
  });
  assert.equal(mappedMember.status, 'conflict');
  assert.ok(mappedMember.conflicts.some(conflict =>
    conflict.code === 'team_template_role_occupation_mismatch' && conflict.roleKey === 'builder'));

  // An explicit mapping of the lead role is used and checked, never silently
  // replaced by the bootstrap seat.
  const mappedLead = await callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template, roleAgentIds: { engineering: 'auto-lead' }
  });
  assert.equal(mappedLead.status, 'conflict');
  assert.ok(mappedLead.conflicts.some(conflict =>
    conflict.code === 'team_template_role_occupation_mismatch' && conflict.roleKey === 'engineering'));

  const imported = await callTeamTool(target.app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(imported.status, 'imported');
  assert.equal(imported.lead.agentId, 'auto-lead');
  assert.equal(imported.lead.seat, 'adopted');
  assert.equal(target.provider.state.agents.size, 2, 'the bootstrap lead plus the one member');
  assert.equal(target.provider.state.assignments.size, 2);

  const team = await target.app.getProjectTeam({ personalSpaceId: SPACE, personalProjectId: TARGET });
  assert.equal(team.lead.agentId, 'auto-lead');
  assert.equal(team.lead.occupation, 'lead');
  const draft = await callTeamTool(target.app, 'read_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET
  });
  assert.equal(draft.leadSeat.occupation, 'engineering');
  assert.equal(draft.leadSeat.responsibility, 'Ship the engineering synthetic build');
});

test('a person-set, ended or already working lead keeps the prior lead-conflict protection', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);

  const personTarget = targetWorld(t);
  personTarget.provider.state.agents.set('person-lead', agent({ id: 'person-lead', occupation: 'manager',
    responsibility: 'Lead the target as the person chose',
    assignments: [assignment({ projectId: TARGET, agentId: 'person-lead',
      responsibility: 'Lead the target as the person chose' })] }));
  personTarget.provider.state.agents.get('person-lead').assignments[0].reason = 'The person appointed this lead';
  personTarget.provider.state.policies.set(TARGET, {
    personal_space_id: SPACE, personal_project_id: TARGET, team_lead_agent_id: 'person-lead',
    team_member_agent_ids: [], sub_teams: [], sub_team_suggestion_threshold: 6,
    updated_at: '2026-03-02T00:00:00.000Z'
  });

  const working = bootstrapTarget(t, { workStatus: 'running', openTasks: 1 });
  const ended = bootstrapTarget(t, { ended: true });
  // The bootstrap lead plus another configured member is a person's own project
  // already, not an empty seat for a first import.
  const withMember = bootstrapTarget(t, { members: ['person-member'] });

  for (const [label, target] of [['person-set', personTarget], ['working', working],
    ['ended', ended], ['other-team', withMember]]) {
    const before = { agents: target.provider.state.agents.size,
      assignments: target.provider.state.assignments.size,
      policy: structuredClone(target.provider.state.policies.get(TARGET)) };
    const preview = await callTeamTool(target.app, 'preview_project_team_template_import', {
      personalSpaceId: SPACE, personalProjectId: TARGET, template
    });
    assert.equal(preview.status, 'conflict', `${label}: preview refuses`);
    assert.ok(preview.conflicts.some(conflict => conflict.code === 'team_template_target_lead_conflict'),
      `${label}: the established lead is never replaced`);

    const applied = await callTeamTool(target.app, 'import_project_team_template', {
      personalSpaceId: SPACE, personalProjectId: TARGET, template
    });
    assert.equal(applied.status, 'conflict', `${label}: import refuses`);
    assert.deepEqual({ agents: target.provider.state.agents.size,
      assignments: target.provider.state.assignments.size,
      policy: target.provider.state.policies.get(TARGET) }, before, `${label}: a refused import writes nothing`);
  }
});

test('an assignment edited after the hire is an established lead, not a first-entry seat', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  // A real first assignment is revision 0. The person later rewrote its
  // responsibility and the revision moved to 1, while the original hire reason
  // stayed: the reason alone must not make it look untouched.
  const target = bootstrapTarget(t, {
    revision: 1, responsibility: 'The person rewrote this lead assignment'
  });
  assert.equal(target.lead.assignments[0].reason, BOOTSTRAP_REASON,
    'the original hire reason is deliberately unchanged');
  const before = { agents: target.provider.state.agents.size,
    assignments: target.provider.state.assignments.size,
    policy: structuredClone(target.provider.state.policies.get(TARGET)) };

  const preview = await callTeamTool(target.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(preview.status, 'conflict');
  assert.ok(preview.conflicts.some(conflict => conflict.code === 'team_template_target_lead_conflict'),
    'an edited assignment keeps the existing lead-conflict protection');

  const applied = await callTeamTool(target.app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(applied.status, 'conflict');
  assert.deepEqual({ agents: target.provider.state.agents.size,
    assignments: target.provider.state.assignments.size,
    policy: target.provider.state.policies.get(TARGET) }, before, 'a refused import writes nothing');
  assert.equal(target.lead.assignments[0].responsibility, 'The person rewrote this lead assignment',
    'the person\'s edit is never overwritten');
});

test('a legacy assignment without a revision uses timestamps as modification evidence', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);

  // No revision field: an update later than the assignment is the evidence.
  const editedLegacy = bootstrapTarget(t, {
    revision: null, updatedAt: '2026-03-09T00:00:00.000Z'
  });
  const editedPreview = await callTeamTool(editedLegacy.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(editedPreview.status, 'conflict');
  assert.ok(editedPreview.conflicts.some(conflict =>
    conflict.code === 'team_template_target_lead_conflict'));

  // The same legacy shape with equal assigned/updated timestamps is untouched.
  const untouchedLegacy = bootstrapTarget(t, { revision: null });
  const untouchedPreview = await callTeamTool(untouchedLegacy.app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(untouchedPreview.status, 'ready');
  assert.equal(untouchedPreview.lead.agentId, 'auto-lead');
  assert.equal(untouchedPreview.lead.seat, 'adopted');
});

test('a matching stored lead-seat binding still reuses an edited assignment without updating it', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = bootstrapTarget(t);
  const { app, provider } = target;
  const first = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(first.status, 'imported');

  // After the import the person edits the lead assignment itself: a new
  // responsibility, a new revision and a new updated_at. The stored leadSeat
  // binding proves this is the same seat, so a retry reuses it and leaves the
  // local edit exactly as the person left it.
  target.lead.assignments[0].responsibility = 'The person owns this lead assignment now';
  target.lead.assignments[0].revision = 1;
  target.lead.assignments[0].updated_at = '2026-04-01T00:00:00.000Z';
  const edited = structuredClone(target.lead);

  const preview = await callTeamTool(app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.lead.agentId, 'auto-lead');
  assert.equal(preview.lead.seat, 'adopted');

  const applied = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(applied.status, 'imported');
  assert.equal(applied.lead.agentId, 'auto-lead');
  assert.deepEqual(provider.state.agents.get('auto-lead'), edited,
    'the local edit is reused as-is, never rewritten by the import');
  assert.equal(provider.state.assignments.size, 3);
});

test('a retry reuses the lead seat when the first import saved the team without its draft receipt', async (t) => {
  const source = sourceWorld(t);
  const template = await exportedTemplate(source.app);
  const target = bootstrapTarget(t);
  const { app, provider } = target;
  const first = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(first.status, 'imported');

  // A partial failure can save the team and its policy but not the receipt. The
  // deterministic member IDs are then the import identity: the same lead seat
  // is still reused instead of reported as a different team.
  for (const file of readdirSync(target.receiptsDirectory)) rmSync(join(target.receiptsDirectory, file));
  const preview = await callTeamTool(app, 'preview_project_team_template_import', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.lead.agentId, 'auto-lead');
  assert.equal(preview.lead.seat, 'adopted');
  assert.deepEqual(preview.conflicts, []);
  assert.equal(preview.templateDraft.action, 'draft', 'the missing draft is offered again');

  const applied = await callTeamTool(app, 'import_project_team_template', {
    personalSpaceId: SPACE, personalProjectId: TARGET, template
  });
  assert.equal(applied.status, 'imported');
  assert.equal(applied.counts.agentsCreated, 0);
  assert.equal(applied.counts.assignmentsCreated, 0);
  assert.equal(applied.lead.agentId, 'auto-lead');
  assert.equal(provider.state.agents.size, 3);
  assert.equal(provider.state.assignments.size, 3);
});

async function importFixture(t, { subTeam, mapMembers }) {
  const source = sourceWorld(t);
  if (subTeam) {
    source.provider.state.policies.get(SOURCE).sub_teams = [{
      id: 'delivery', name: 'Delivery', lead_agent_id: 'member-1', member_agent_ids: ['member-2']
    }];
  }
  const target = bootstrapTarget(t);
  const input = { personalSpaceId: SPACE, personalProjectId: TARGET, template: await exportedTemplate(source.app) };
  if (mapMembers) {
    input.roleAgentIds = { builder: 'my-builder', reviewer: 'my-reviewer' };
    for (const [occupation, id] of Object.entries(input.roleAgentIds)) {
      target.provider.state.agents.set(id, agent({ id, occupation, responsibility: 'Existing specialist',
        assignments: [assignment({ projectId: TARGET, agentId: id, responsibility: 'Existing work' })] }));
    }
  }
  return { target, input };
}

async function interruptFinalDraft(target, input) {
  target.receipts.keep = () => { throw new Error('synthetic draft write failure'); };
  const partial = await callTeamTool(target.app, 'import_project_team_template', input);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.failure.message, 'synthetic draft write failure');
  assert.equal(partial.applied.policy, 'updated');
  target.app.teamTemplateReceipts = createTeamTemplateReceipts({ directory: target.receiptsDirectory });
  assert.equal(target.app.teamTemplateReceipts.read(SPACE, TARGET), null);
}

for (const [name, subTeam, mapMembers] of [
  ['sub-team', true, false], ['mapped members', false, true], ['mapped sub-team', true, true]
]) {
  test(`a retry after the policy write reuses the bootstrap lead with ${name}`, async (t) => {
    const { target, input } = await importFixture(t, { subTeam, mapMembers });
    await interruptFinalDraft(target, input);
    const before = structuredClone(target.provider.state.policies.get(TARGET));
    const preview = await callTeamTool(target.app, 'preview_project_team_template_import', input);
    assert.deepEqual(preview.conflicts, []);
    assert.equal(preview.lead.seat, 'adopted');
    assert.equal(preview.policy.action, 'unchanged');
    const retry = await callTeamTool(target.app, 'import_project_team_template', input);
    assert.equal(retry.status, 'imported');
    assert.equal(retry.applied.templateDraft, 'drafted');
    assert.deepEqual([retry.counts.agentsCreated, retry.counts.assignmentsCreated, retry.counts.workflowsProposed], [0, 0, 0]);
    assert.deepEqual(target.provider.state.policies.get(TARGET), before);
    assert.equal(target.app.teamTemplateReceipts.read(SPACE, TARGET).leadSeat.agentId, 'auto-lead');
  });
}

test('an existing team that exactly matches the requested mapped layout stays person-owned', async (t) => {
  const { target, input } = await importFixture(t, { subTeam: true, mapMembers: true });
  const policy = target.provider.state.policies.get(TARGET);
  policy.team_member_agent_ids = ['my-builder', 'my-reviewer'];
  policy.sub_teams = [{ id: 'delivery', name: 'Delivery', lead_agent_id: 'my-builder', member_agent_ids: ['my-reviewer'] }];
  const before = structuredClone(policy);
  const result = await callTeamTool(target.app, 'import_project_team_template', input);
  assert.equal(result.status, 'conflict');
  assert.ok(result.conflicts.some(conflict => conflict.code === 'team_template_target_lead_conflict'));
  assert.deepEqual(target.provider.state.policies.get(TARGET), before);
  assert.equal(target.receipts.read(SPACE, TARGET), null);
});

test('a retry after a person clears the partially imported layout keeps that edit', async (t) => {
  const { target, input } = await importFixture(t, { subTeam: true, mapMembers: true });
  await interruptFinalDraft(target, input);
  const policy = target.provider.state.policies.get(TARGET);
  policy.team_member_agent_ids = [];
  policy.sub_teams = [];
  policy.updated_at = '2026-11-26T00:00:00Z';
  const before = structuredClone(policy);
  const result = await callTeamTool(target.app, 'import_project_team_template', input);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(target.provider.state.policies.get(TARGET), before);
  assert.equal(target.app.teamTemplateReceipts.read(SPACE, TARGET), null);
});

test('a failed policy write resumes from the original revision and survives losing its acknowledgement', async (t) => {
  const { target, input } = await importFixture(t, { subTeam: true, mapMembers: true });
  const { app } = target;
  const update = app.updateProjectAgentCoordinationPolicy.bind(app);
  app.updateProjectAgentCoordinationPolicy = async () => { throw new Error('before policy write'); };
  const before = await callTeamTool(app, 'import_project_team_template', input);
  assert.equal(before.failure.message, 'before policy write');
  assert.deepEqual(target.provider.state.policies.get(TARGET).team_member_agent_ids, []);
  app.updateProjectAgentCoordinationPolicy = async input => { await update(input); throw new Error('after policy write'); };
  const after = await callTeamTool(app, 'import_project_team_template', input);
  assert.equal(after.failure.message, 'after policy write');
  assert.equal(target.receipts.read(SPACE, TARGET), null);
  app.updateProjectAgentCoordinationPolicy = () => assert.fail('the durable policy was already written');
  const retry = await callTeamTool(app, 'import_project_team_template', input);
  assert.equal(retry.status, 'imported');
  assert.equal(retry.counts.policyChanged, false);
});

test('a partial import from before adoption records uses its generated specialist as evidence', async (t) => {
  const { target, input } = await importFixture(t, { subTeam: true, mapMembers: true });
  delete input.roleAgentIds.reviewer;
  await interruptFinalDraft(target, input);
  // Older builds had no local evidence until the final draft succeeded.
  for (const file of readdirSync(target.receiptsDirectory)) rmSync(join(target.receiptsDirectory, file));
  const retry = await callTeamTool(target.app, 'import_project_team_template', input);
  assert.equal(retry.status, 'imported');
  assert.equal(retry.counts.policyChanged, false);
  assert.equal(retry.counts.assignmentsCreated, 0);
});
