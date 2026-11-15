import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRoundtableHost, ROUNDTABLE_HOST_METHODS } from '../packages/roundtable/src/host.js';
import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

test('Roundtable refuses a host that is missing part of the port', () => {
  const partial = Object.fromEntries(ROUNDTABLE_HOST_METHODS.slice(1).map(name => [name, () => null]));
  assert.throws(() => assertRoundtableHost(partial), /missing: spaceId/);
  assert.throws(() => createAgentRoundtable({ host: partial, openStore: () => createRoundtableStore() }), /missing: spaceId/);
});

test('FULI hosts Roundtable with its Provider records in the port shapes', async () => {
  const calls = [];
  const app = {
    config: { personal: { spaceId: 'space-1' } },
    listProjectAgents: async input => { calls.push(['agents', input]); return [{ agentId: 'lead', profile: { status: 'active' } }]; },
    taskContextRegistry: { context: async (token, client) => ({ token, client }) },
    projectPathResolver: path => path === '/work/app' ? { status: 'matched', personalProjectId: 'app' } : { status: 'unmatched' },
    personal: {
      recentAgentSessions: async input => { calls.push(['sessions', input]);
        return [{ source_application: 'codex', session_id: 's-1', personal_project_id: 'app', last_active: 't' }]; },
      listPersonalProjects: async () => ({ projects: [{ project_id: 'app', scope_type: 'registered', profile: { name: 'App',
        sources: [{ kind: 'repository', role: 'own', uri: 'git@example.test:team/app.git' },
          { kind: 'repository', role: 'reference', uri: 'https://example.test/team/lib' }] } },
        { project_id: 'tmp', scope_type: 'temporary', profile: { lifecycle: 'archived' } }] }),
      getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: 'lead' }),
      issueAgentDelegation: async input => { calls.push(['issue', input]); return { token: 't' }; },
      verifyAgentDelegation: async () => ({ redeemed: true, memory_result_count: 2 }),
      issueRemoteAgentOrigin: async input => { calls.push(['origin', input]); return { agent_id: 'lead', proof: 'p' }; }
    }
  };
  const host = createFuliRoundtableHost(app);
  assert.equal(host.spaceId(), 'space-1');
  assert.deepEqual(await host.recentSessions({ agentId: 'lead', projectId: 'app', limit: 5 }),
    [{ client: 'codex', sessionId: 's-1', projectId: 'app', lastActive: 't' }]);
  assert.deepEqual(calls.at(-1), ['sessions', { personalSpaceId: 'space-1', agentId: 'lead', personalProjectId: 'app', limit: 5 }]);
  // Only the project's own repository identifies it to paired devices; a reference never does.
  assert.deepEqual(await host.listProjects(), [{ projectId: 'app', name: 'App', temporary: false, sessionOnly: false, archived: false,
    repositories: ['example.test/team/app'] }, { projectId: 'tmp', name: null, temporary: true, sessionOnly: false, archived: true, repositories: [] }]);
  assert.equal(await host.projectLeadId('app'), 'lead');
  assert.equal(await host.projectForPath('/work/app'), 'app');
  assert.equal(await host.projectForPath('/elsewhere'), null);
  assert.deepEqual(await host.verifyDelegation({ token: 't', sessionId: 's' }), { redeemed: true, memoryResultCount: 2 });
  await host.issueDelegation({ taskContextToken: 'task', client: 'codex', agentId: 'lead', targetClient: 'claude_code',
    targetSessionId: null, lifetimeSeconds: 60 });
  assert.deepEqual(calls.at(-1), ['issue', { personal_space_id: 'space-1', task_context_token: 'task', source_application: 'codex',
    agent_id: 'lead', target_application: 'claude_code', target_session_id: null, lifetime_seconds: 60 }]);
  await host.issueRemoteOrigin({ taskContextToken: 'task', client: 'codex', messageId: 'm', digest: 'd', targetNode: 'n',
    bindingId: 'chat', expiresAt: 'e', purpose: 'chat' });
  assert.equal(calls.at(-1)[1].purpose, 'chat');
  assert.deepEqual(await host.recordMemoryUsage({}), { recorded: false, reason: 'usage_port_unavailable' });
});

test('the person\'s own names for work find the leads of this space\'s open projects', async t => {
  const standing = createStandingAssignments();
  t.after(() => standing.close());
  const register = (personalSpaceId, projectId, leadAgentId, terms, responsibility) => standing.register({
    personalSpaceId, projectId, leadAgentId, terms, responsibility, source: 'user' }).assignment;
  register('space-1', 'idev', 'lead-idev', ['iDev timesheet', '工时'], '每天填写 iDev 工时');
  register('space-2', 'app', 'lead-app', ['报销'], '处理报销');
  register('space-1', 'old', 'lead-old', ['归档'], '旧工作');
  const retired = register('space-1', 'app', 'lead-app', ['周报'], '写周报');
  standing.correct(retired.assignmentId, { action: 'retire' }, { source: 'user', expectedRevision: retired.revision });
  const leads = { idev: 'lead-idev', app: 'lead-app', old: 'lead-old' };
  const app = {
    config: { personal: { spaceId: 'space-1' } },
    standingAssignments: standing,
    listProjectAgents: async () => Object.values(leads).map(agentId => ({ agentId,
      profile: { name: agentId, responsibility: '项目负责人', allowedClients: ['codex'], status: 'active' } })),
    personal: {
      listPersonalProjects: async () => [{ project_id: 'idev', profile: { name: 'iDev 工时' } },
        { project_id: 'app', profile: { name: 'App' } }, { project_id: 'old', profile: { name: 'Old 工时', lifecycle: 'archived' } },
        { project_id: 'scratch', scope_type: 'temporary', profile: { name: 'App scratch' } }],
      getProjectAgentCoordinationPolicy: async (_space, projectId) => ({ team_lead_agent_id: leads[projectId] ?? null }),
      recentAgentSessions: async () => []
    }
  };
  const host = createFuliRoundtableHost(app);
  const idev = { agentId: 'lead-idev', projectId: 'idev', project: 'iDev 工时', responsibility: '每天填写 iDev 工时' };
  assert.deepEqual(await host.matchWork('工时'), [{ ...idev, matchedTerms: ['工时'] }], 'term; archived project excluded');
  assert.deepEqual(await host.matchWork('谁做 Timesheet？'), [], 'a term is matched whole');
  assert.deepEqual(await host.matchWork('TIMESHEET'), [{ ...idev, matchedTerms: ['iDev timesheet'] }]);
  assert.deepEqual(await host.matchWork('填写'), [{ ...idev, matchedTerms: [] }], 'responsibility');
  assert.deepEqual(await host.matchWork('ａｐｐ'), [{ agentId: 'lead-app', projectId: 'app', project: 'App' }], 'project name');
  assert.deepEqual(await host.matchWork('报销'), [], 'another space');
  assert.deepEqual(await host.matchWork('周报'), [], 'retired');
  assert.deepEqual(await host.matchWork('idevelop'), [], 'word edges');

  const roundtable = createAgentRoundtable({ host, openStore: () => createRoundtableStore() });
  const [found] = (await roundtable.findAgents({ query: '工时' })).agents;
  assert.deepEqual([found.agentId, found.matchedWork], ['lead-idev', [{ projectId: 'idev', project: 'iDev 工时',
    responsibility: '每天填写 iDev 工时', matchedTerms: ['工时'] }]]);

  // An unreadable store leaves project names, said once and by code only.
  const warnings = [];
  const unreadable = createFuliRoundtableHost({ ...app, standingAssignments: { discover: () => {
    throw Object.assign(new Error('T:/synthetic/data/standing-assignments.sqlite is newer'), { code: 'data_format_newer' });
  } } }, { warn: line => warnings.push(line) });
  assert.deepEqual(await unreadable.matchWork('工时'), [{ agentId: 'lead-idev', projectId: 'idev', project: 'iDev 工时' }]);
  const degraded = createAgentRoundtable({ host: unreadable, openStore: () => createRoundtableStore() });
  assert.deepEqual((await degraded.findAgents({ query: 'App' })).agents.map(agent => agent.agentId), ['lead-app']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /project names only.*\(data_format_newer\)/);
  assert.doesNotMatch(warnings[0], /synthetic/);
});

test('a project whose lead cannot be read is left out of work matches; the others still match', async () => {
  const host = createFuliRoundtableHost({
    config: { personal: { spaceId: 'space-1' } },
    standingAssignments: createStandingAssignments(),
    personal: {
      listPersonalProjects: async () => [{ project_id: 'app', profile: { name: 'App' } },
        { project_id: 'app-store', profile: { name: 'App store' } }],
      getProjectAgentCoordinationPolicy: async (_space, projectId) => {
        if (projectId === 'app-store') throw new Error('synthetic policy read failure');
        return { team_lead_agent_id: 'lead-app' };
      }
    }
  });
  assert.deepEqual(await host.matchWork('app'), [{ agentId: 'lead-app', projectId: 'app', project: 'App' }]);
  assert.deepEqual(await host.matchWork('\u0085'), []);
});

test('a folder belongs to a project FULI maps it to, or whose own recorded repository it is a checkout of', async (t) => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'host-folder-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A checkout whose origin two projects record (FULI then names neither), spelled in another case than they recorded it.
  const checkout = join(root, 'checkout');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  writeFileSync(join(checkout, '.git', 'config'), '[remote "origin"]\n\turl = https://example.test/Team/App.git\n');
  const plain = join(root, 'plain');
  mkdirSync(plain);
  // The same repository in a folder FULI maps to another project (its address is recorded there in the checkout's own spelling).
  const cased = join(root, 'cased');
  mkdirSync(join(cased, '.git'), { recursive: true });
  writeFileSync(join(cased, '.git', 'config'), '[remote "origin"]\n\turl = https://example.test/Team/App.git\n');
  const own = (uri) => ({ sources: [{ kind: 'repository', role: 'own', uri }] });
  const app = {
    config: { personal: { spaceId: 'space-1' } },
    projectPathResolver: path => path === '/work/app' ? { status: 'matched', personalProjectId: 'app' }
      : path === cased ? { status: 'matched', personalProjectId: 'other' } : { status: 'ambiguous', candidateCount: 2 },
    personal: { listPersonalProjects: async () => ({ projects: [
      { project_id: 'app', scope_type: 'registered', profile: { name: 'App', ...own('git@example.test:team/app.git') } },
      { project_id: 'app-twin', scope_type: 'registered', profile: { name: 'Twin', ...own('https://example.test/team/app') } },
      { project_id: 'other', scope_type: 'registered', profile: { name: 'Other', ...own('https://example.test/team/other') } },
      { project_id: 'gone', scope_type: 'registered', profile: { name: 'Gone', lifecycle: 'archived', ...own('https://example.test/team/app') } },
      { project_id: 'scratch', scope_type: 'temporary', profile: { name: 'Scratch', ...own('https://example.test/team/app') } }] }) }
  };
  const host = createFuliRoundtableHost(app);
  assert.equal(await host.folderBelongsTo('/work/app', 'app'), true, 'the one project FULI maps the folder to');
  assert.equal(await host.projectForPath(checkout), null, 'two projects record this repository: FULI names neither');
  assert.equal(await host.folderBelongsTo(checkout, 'app'), true, 'a checkout of the project’s own repository');
  assert.equal(await host.folderBelongsTo(checkout, 'app-twin'), true);
  assert.equal(await host.folderBelongsTo(checkout, 'other'), false, 'another project’s repository');
  assert.equal(await host.folderBelongsTo(checkout, 'gone'), false, 'an archived project');
  assert.equal(await host.folderBelongsTo(checkout, 'scratch'), false, 'a temporary project');
  assert.equal(await host.folderBelongsTo(checkout, 'unknown'), false);
  assert.equal(await host.folderBelongsTo(cased, 'other'), true, 'the project FULI maps it to');
  assert.equal(await host.folderBelongsTo(cased, 'app'), true, 'mapped to another project, and still a checkout of this one’s own repository');
  assert.equal(await host.folderBelongsTo(cased, 'gone'), false);
  assert.equal(await host.folderBelongsTo(plain, 'app'), false, 'no repository, and FULI does not map it');
  assert.equal(await host.folderBelongsTo('', 'app'), false);
});
