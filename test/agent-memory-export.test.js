import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { createAgentDirectorySnapshots } from '../src/agents/directory-snapshots.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';

// Synthetic temp data and an HTTP Provider double only.
const SPACE = 'test-space';
const config = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-provider-token', principalId: 'test-person', spaceId: SPACE } };
const SECRETS = ['synthetic-provider-token', 'fuli-task-secret', 'synthetic-session-secret', 'synthetic-task-id',
  'private-other-project', 'checkpoint-secret', 'RAW-CONVERSATION'];

function agentRecord(overrides = {}) {
  return { agent_id: 'engineer', personal_space_id: SPACE, personal_project_id: 'sample-project',
    memory_scope: 'reviewed_agent', employee_number: 7,
    profile: { name: 'Engineer', display_name: 'Engineer (display)', status: 'active',
      responsibility: 'Maintain the sample service.', allowed_clients: ['codex'] },
    assignments: [{ personal_project_id: 'private-other-project', task_context_token: 'fuli-task-secret' }],
    ...overrides };
}

function memoryView(project, revision, summary, extra = {}) {
  return { personal_space_id: SPACE, personal_project_id: project, agent_id: 'engineer', revision,
    scope: project === null ? 'private_agent_global' : 'private_agent_project', storage: 'neo4j',
    current: revision ? { revision, agent_id: 'engineer', personal_project_id: project, checkpoint_id: 'checkpoint-secret',
      created_at: '2026-10-13T08:00:00Z', source_application: 'codex', source_session_id: 'synthetic-session-secret',
      task_id: 'synthetic-task-id', memory: { summary, decisions: ['Use the graph.'], next_actions: [] } } : null,
    history: [],
    work_log: [{ summary: 'RAW-CONVERSATION excerpt', task_context_token: 'fuli-task-secret', status: 'done' }],
    ...extra };
}

function provider({ agent = agentRecord(), memories = {} } = {}) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    requests.push({ method: options.method ?? 'GET', path: target.pathname, project: target.searchParams.get('personal_project_id') });
    if (target.pathname === '/v1/project-agents/engineer') return Response.json(agent);
    if (target.pathname === '/v1/project-agents/engineer/memory') {
      const project = target.searchParams.get('personal_project_id');
      return Response.json(memories[project ?? 'global'] ?? memoryView(project, 0, null));
    }
    return Response.json({ detail: 'not found' }, { status: 404 });
  };
  return { fetchImpl, requests, memories };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'fuli-memory-export-'));
  mkdirSync(join(home, 'data'));
  const root = join(home, 'data', 'agents');
  const app = (double, { snapshots = true } = {}) => {
    const application = new FederatedGraphApplication(config, { fetchImpl: double.fetchImpl });
    if (snapshots) application.agentSnapshots = createAgentDirectorySnapshots({ root, providerIdentity: config.personal.providerUrl });
    return application;
  };
  return { home, root, app, cleanup: () => { chmodSync(join(home, 'data'), 0o700); rmSync(home, { recursive: true, force: true }); } };
}

const input = (personalProjectId = 'sample-project', overrides = {}) =>
  ({ personalSpaceId: SPACE, personalProjectId, agentId: 'engineer', sourceApplication: 'codex', ...overrides });
const memoryReads = double => double.requests.filter(request => request.path.endsWith('/memory'));

test('export renders identity and exactly the selected scope from a fresh database read, never from an edited file', async () => {
  const { root, app, cleanup } = fixture();
  try {
    const double = provider({ memories: {
      'sample-project': memoryView('sample-project', 3, 'Database project summary.'),
      global: memoryView(null, 2, 'Database global method.')
    } });
    const application = app(double);
    const first = await callAgentTool(application, 'export_project_agent_memory', input());
    // Forge the generated project file; the next export must still come from the database.
    const snapshot = (await callAgentTool(application, 'get_project_agent_memory', input())).directorySnapshot;
    const projectFile = join(root, ...snapshot.path.split('/').slice(1), snapshot.files[1].file);
    writeFileSync(projectFile, '# Forged\n\nForged summary.\n');
    double.memories['sample-project'] = memoryView('sample-project', 4, 'Newer database summary.');
    const exported = await callAgentTool(application, 'export_project_agent_memory', input());

    assert.equal(first.revision, 3);
    assert.equal(exported.revision, 4);
    assert.equal(exported.scope, 'private_agent_project');
    assert.equal(exported.authority, 'database');
    assert.equal(exported.recordedAt, '2026-10-13T08:00:00Z');
    assert.match(exported.markdown, /^# Engineer \(display\)\n/);
    assert.match(exported.markdown, /Employee number: 7/);
    assert.match(exported.markdown, /not the authority: edits are not imported/);
    assert.match(exported.markdown, /Scope: private_agent_project/);
    assert.match(exported.markdown, /Database revision: 4/);
    assert.match(exported.markdown, /Recorded: 2026-10-13T08:00:00Z/);
    assert.match(exported.markdown, /Generated: \d{4}-\d{2}-\d{2}T/);
    assert.match(exported.markdown, /Newer database summary\./);
    assert.equal(exported.markdown.includes('Forged'), false, 'edited Markdown is never read back');
    assert.equal(exported.markdown.includes('Database global method'), false, 'project export excludes global memory');
    assert.equal(exported.filename, 'fuli-engineer-project-sample-project-memory-r4.md');
    assert.deepEqual(memoryReads(double).map(request => request.project),
      ['sample-project', 'sample-project', 'sample-project'], 'no other scope is fetched');

    const global = await callAgentTool(application, 'export_project_agent_memory', input(null));
    assert.equal(global.scope, 'private_agent_global');
    assert.equal(global.filename, 'fuli-engineer-global-memory-r2.md');
    assert.match(global.markdown, /Database global method\./);
    assert.equal(global.markdown.includes('project summary'), false, 'global export excludes project memory');
    assert.equal(memoryReads(double).at(-1).project, null);
  } finally { cleanup(); }
});

test('export omits tokens, session and task IDs, raw conversation, assignments and runtime paths', async () => {
  const { home, app, cleanup } = fixture();
  try {
    const double = provider({ memories: { 'sample-project': memoryView('sample-project', 1, 'Safe summary.') } });
    const exported = await callAgentTool(app(double), 'export_project_agent_memory', input());
    const everything = JSON.stringify(exported);
    for (const secret of [...SECRETS, home]) assert.equal(everything.includes(secret), false, secret);
    assert.equal('directorySnapshot' in exported, false, 'local persistence is not claimed');
  } finally { cleanup(); }
});

test('unauthorized clients, inactive or task-only Agents and foreign spaces are rejected before any memory read', async () => {
  const { app, cleanup } = fixture();
  try {
    const cases = [
      [provider(), input('sample-project', { sourceApplication: 'cursor' }), /client is not allowed/],
      [provider({ agent: agentRecord({ memory_scope: 'task_only' }) }), input(), /active durable Agent/],
      [provider({ agent: agentRecord({ profile: { ...agentRecord().profile, status: 'paused' } }) }), input(), /active durable Agent/],
      [provider(), input('sample-project', { personalSpaceId: 'other-space' }), /./]
    ];
    for (const [double, request, error] of cases) {
      await assert.rejects(callAgentTool(app(double), 'export_project_agent_memory', request), error);
      assert.deepEqual(memoryReads(double), [], 'nothing rendered or fetched');
    }
  } finally { cleanup(); }
});

test('an unassigned project is rejected by the Provider and no other project is fetched', async () => {
  const double = provider();
  const base = double.fetchImpl;
  const application = new FederatedGraphApplication(config, { fetchImpl: async (url, options) =>
    new URL(url).searchParams.get('personal_project_id') === 'unassigned-project'
      ? (double.requests.push({ path: new URL(url).pathname, project: 'unassigned-project' }),
        Response.json({ detail: 'Agent is not assigned to this project' }, { status: 403 }))
      : base(url, options) });
  await assert.rejects(callAgentTool(application, 'export_project_agent_memory', input('unassigned-project')));
  assert.deepEqual([...new Set(double.requests.map(request => request.project))], ['unassigned-project'],
    'no implicit fetch of another project');
});

test('malformed outer, current or history scope and revision mismatches are rejected before Markdown is produced', async () => {
  const { app, cleanup } = fixture();
  try {
    const record = memoryView('sample-project', 3, 'FOREIGN content').current;
    const views = {
      'outer space': memoryView('sample-project', 3, 'FOREIGN content', { personal_space_id: 'other-space' }),
      'outer project': memoryView('sample-project', 3, 'FOREIGN content', { personal_project_id: 'private-other-project' }),
      'outer agent': memoryView('sample-project', 3, 'FOREIGN content', { agent_id: 'reviewer' }),
      'outer scope': memoryView('sample-project', 3, 'FOREIGN content', { scope: 'private_agent_global' }),
      'current agent': memoryView('sample-project', 3, 'FOREIGN content', { current: { ...record, agent_id: 'reviewer' } }),
      'current project': memoryView('sample-project', 3, 'FOREIGN content', { current: { ...record, personal_project_id: 'private-other-project' } }),
      'current revision': memoryView('sample-project', 3, 'FOREIGN content', { current: { ...record, revision: 9 } }),
      'revision without current': memoryView('sample-project', 3, 'FOREIGN content', { current: null }),
      'history agent': memoryView('sample-project', 3, 'FOREIGN content', { history: [{ ...record, revision: 2, agent_id: 'reviewer' }] }),
      'history duplicate of current': memoryView('sample-project', 3, 'FOREIGN content', { history: [{ ...record, personal_space_id: 'other-space' }] }),
      'history newer than view': memoryView('sample-project', 3, 'FOREIGN content', { history: [{ ...record, revision: 8 }] })
    };
    for (const [label, view] of Object.entries(views)) {
      const double = provider({ memories: { 'sample-project': view } });
      await assert.rejects(callAgentTool(app(double), 'export_project_agent_memory', input()),
        /invalid Agent memory record/, label);
    }
    // The owner export applies the same validator.
    const double = provider({ memories: { 'sample-project': views['current agent'] } });
    await assert.rejects(app(double).exportInspectedProjectAgentMemory(input()), /invalid Agent memory record/);
  } finally { cleanup(); }
});

test('empty memory exports a truthful empty scope', async () => {
  const { app, cleanup } = fixture();
  try {
    const exported = await callAgentTool(app(provider()), 'export_project_agent_memory', input(null));
    assert.equal(exported.revision, 0);
    assert.equal(exported.recordedAt, null);
    assert.match(exported.markdown, /Database revision: 0/);
    assert.match(exported.markdown, /No working memory has been recorded in this scope yet\./);
    assert.equal(exported.filename, 'fuli-engineer-global-memory-r0.md');
  } finally { cleanup(); }
});

test('Markdown, HTML and credential-like content stays inert text', async () => {
  const { app, cleanup } = fixture();
  try {
    const hostile = '<script>alert(1)</script> [link](javascript:alert(1)) ../../etc/passwd\n# Heading injection';
    const double = provider({ agent: agentRecord({ agent_id: 'engineer', profile: { ...agentRecord().profile, display_name: '../../<b>Eng</b>' } }),
      memories: { 'sample-project': memoryView('sample-project', 2, hostile) } });
    const exported = await callAgentTool(app(double), 'export_project_agent_memory', input());
    assert.equal(typeof exported.markdown, 'string');
    assert.match(exported.markdown, /<script>alert\(1\)<\/script>/, 'returned verbatim as text, never executed or fetched');
    assert.match(exported.filename, /^fuli-[a-z0-9_-]+-project-[a-z0-9_-]+-memory-r2\.md$/);

    const unsafe = provider({ memories: { 'sample-project': memoryView('sample-project', 1, 'token=sk-live-abcdefghijklmnopqrstuvwxyz0123456789') } });
    const withheld = await callAgentTool(app(unsafe), 'export_project_agent_memory', input());
    assert.match(withheld.markdown, /Content withheld/);
    assert.equal(withheld.markdown.includes('sk-live-abcdefghijklmnopqrstuvwxyz0123456789'), false);
  } finally { cleanup(); }
});

test('unsafe identifiers never shape the suggested filename', async () => {
  const { app, cleanup } = fixture();
  try {
    const double = provider({ memories: { 'sample-project': memoryView('sample-project', 1, 'Summary.') } });
    const application = app(double);
    application.personal.getProjectAgentMemory = async () => ({ ...memoryView('../x y', 1, 'Summary.'),
      current: { ...memoryView('../x y', 1, 'Summary.').current } });
    const exported = await application.exportInspectedProjectAgentMemory(input('../x y'));
    assert.match(exported.filename, /^fuli-engineer-project-[0-9a-f]{12}-memory-r1\.md$/);
  } finally { cleanup(); }
});

test('export still succeeds when the optional directory cannot be written and claims no local persistence', async () => {
  const { home, app, cleanup } = fixture();
  try {
    chmodSync(join(home, 'data'), 0o500);
    const double = provider({ memories: { 'sample-project': memoryView('sample-project', 2, 'Still exported.') } });
    const exported = await callAgentTool(app(double), 'export_project_agent_memory', input());
    assert.match(exported.markdown, /Still exported\./);
    assert.equal('directorySnapshot' in exported, false);
    const broken = app(double);
    broken.agentSnapshots = { materialize() { throw new Error('EACCES synthetic'); } };
    assert.match((await callAgentTool(broken, 'export_project_agent_memory', input())).markdown, /Still exported\./);
    assert.match((await callAgentTool(app(double, { snapshots: false }), 'export_project_agent_memory', input())).markdown,
      /Still exported\./);
  } finally { cleanup(); }
});

test('the owner console route exports under inspection authority without the client allow-list', async () => {
  const { app, cleanup } = fixture();
  try {
    const agent = agentRecord({ profile: { ...agentRecord().profile, allowed_clients: [] } });
    const double = provider({ agent, memories: { 'sample-project': memoryView('sample-project', 5, 'Owner export.') } });
    const application = app(double);
    let status; let body;
    const response = { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
    const url = new URL(`http://127.0.0.1/api/project-agents/engineer/memory/export?personalSpaceId=${SPACE}&personalProjectId=sample-project`);
    assert.equal(await handleGraphApiRequest({ request: { method: 'GET' }, response, url, app: application }), true);
    assert.equal(status, 200);
    assert.match(body.markdown, /Owner export\./);
    assert.equal(body.filename, 'fuli-engineer-project-sample-project-memory-r5.md');
    // The Agent tool still applies the client allow-list for the same Agent.
    await assert.rejects(callAgentTool(application, 'export_project_agent_memory', input()), /client is not allowed/);
    const taskOnly = provider({ agent: agentRecord({ memory_scope: 'task_only' }) });
    await assert.rejects(app(taskOnly).exportInspectedProjectAgentMemory(input()), /durable Agent/);
    assert.deepEqual(memoryReads(taskOnly), []);
    await assert.rejects(application.exportInspectedProjectAgentMemory(input('sample-project', { personalSpaceId: 'other-space' })));
  } finally { cleanup(); }
});

test('the directory file and the export carry the same generated notice', async () => {
  const { root, app, cleanup } = fixture();
  try {
    const double = provider({ memories: { 'sample-project': memoryView('sample-project', 1, 'Same content.') } });
    const application = app(double);
    const exported = await callAgentTool(application, 'export_project_agent_memory', input());
    const snapshot = (await callAgentTool(application, 'get_project_agent_memory', input())).directorySnapshot;
    const file = readFileSync(join(root, ...snapshot.path.split('/').slice(1), snapshot.files[1].file), 'utf8');
    assert.match(file, /Same content\./);
    const notice = file.split('\n').find(line => line.startsWith('> '));
    assert.ok(exported.markdown.includes(notice));
  } finally { cleanup(); }
});
