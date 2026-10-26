import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudgmentService } from '../src/judgment/service.js';
import { judgmentArgs } from '../src/agents/judgment-registry.js';

test('service validates active space, project, real roster, revisions and enums', async t => {
  const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg' }] };
  const service = createJudgmentService({ app }); t.after(() => service.close());
  await assert.rejects(service.pins({ personalSpaceId: 'another' }), { status: 403 });
  await assert.rejects(service.policy({ personalSpaceId: 's', personalProjectId: 'unknown' }), { status: 404 });
  await assert.rejects(service.pin({ personalSpaceId: 's', agentId: 'invented', pinned: true, expectedRevision: 0 }), { status: 404 });
  assert.equal((await service.pin({ personalSpaceId: 's', agentId: 'employee.tonborg', pinned: false, expectedRevision: 0 })).agentIds.length, 2);
  await assert.rejects(service.pin({ personalSpaceId: 's', agentId: 'employee.tonborg', pinned: true, expectedRevision: 0 }), { status: 409 });
  await assert.rejects(service.setPolicy({ personalSpaceId: 's', policy: { mode: 'everything' }, expectedRevision: 0 }), TypeError);
});

test('judgment clients disable customization and tools, retain no client sessions', () => {
  const codex = judgmentArgs('codex', { cwd: '/test', quality: 'quality' });
  assert.ok(codex.includes('--ignore-user-config'));
  assert.ok(codex.includes('--ephemeral'));
  assert.ok(codex.includes('features.shell_tool=false'));
  const claude = judgmentArgs('claude_code', { quality: 'quality' });
  assert.ok(claude.includes('--safe-mode'));
  assert.equal(claude[claude.indexOf('--tools') + 1], '');
  assert.ok(claude.includes('--strict-mcp-config'));
});

test('conversation questions exclude other projects and require the active authorized scope', async t => {
  const app = { config: { personal: { spaceId: 's' } },
    listPersonalProjects: async () => [{project_id: 'p'}],
    personal: { readVisibleKnowledgeItems: async ({ items }) => ({ items }) } };
  const service = createJudgmentService({ app }); t.after(() => service.close());
  service.store().record('s', {personalProjectId:'other', kind:'review', outcome:'escalate',
    target:'entity:foreign', title:'Foreign', summary:'Other project', evidenceFingerprint:'foreign'}, 'foreign');
  const own = service.store().record('s', {personalProjectId:'p', kind:'review', outcome:'escalate',
    target:'entity:own', title:'Own', summary:'Choose a correction', evidenceFingerprint:'own'}, 'own');
  const result = await service.agent.conversationQuestions({personalSpaceId:'s', personalProjectId:'p'});
  assert.equal(result.human_interaction.source.id, own.id);
  await assert.rejects(service.agent.conversationQuestions({personalSpaceId:'foreign',personalProjectId:'p'}), {status:403});
  await assert.rejects(service.agent.conversationQuestions({personalSpaceId:'s',personalProjectId:'other'}), {status:404});
});

test('policy overrides list the default and each active project\'s own policy; a removed or archived one is not listed', async t => {
  const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }, { project_id: 'q' },
    { project_id: 'old', profile: { lifecycle: 'archived' } }] };
  const service = createJudgmentService({ app }); t.after(() => service.close());
  const policy = mode => ({ mode, quality: 'quality', client: 'claude_code' });
  await service.setPolicy({ personalSpaceId: 's', policy: policy('shared'), expectedRevision: 0 });
  await service.setPolicy({ personalSpaceId: 's', personalProjectId: 'p', policy: policy('autonomous'), expectedRevision: 0 });
  await service.setPolicy({ personalSpaceId: 's', personalProjectId: 'q', policy: policy('manual'), expectedRevision: 0 });
  service.store().setPolicy('s', 'old', policy('autonomous'), 0);
  await service.setPolicy({ personalSpaceId: 's', personalProjectId: 'q', policy: null, expectedRevision: 1 });
  const listed = await service.policyOverrides({ personalSpaceId: 's' });
  assert.deepEqual([listed.default.mode, listed.default.personalProjectId], ['shared', null]);
  assert.deepEqual(listed.overrides.map(({ personalProjectId, mode, inherited, revision }) => ({ personalProjectId, mode, inherited, revision })),
    [{ personalProjectId: 'p', mode: 'autonomous', inherited: false, revision: 1 }]);
  await assert.rejects(service.policyOverrides({ personalSpaceId: 'another' }), { status: 403 });
});
