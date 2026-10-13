import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { createAgentDirectorySnapshots } from '../src/agents/directory-snapshots.js';
import { FederatedGraphApplication, openFederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { withTaskMemorySnapshot } from '../src/graphiti/project-agent-memory.js';

// Synthetic temp data and an HTTP Provider double only.
const SPACE = 'test-space';
const config = (spaceId = SPACE, providerUrl = 'http://127.0.0.1:8787') => ({ version: 1,
  personal: { providerUrl, accessToken: 'synthetic-provider-token', principalId: 'test-person', spaceId },
  workspaces: [] });
const permissionsEnforced = process.getuid?.() !== 0;

function agentRecord({ agentId = 'engineer', spaceId = SPACE, name = 'Engineer', legacy = false, updatedAt } = {}) {
  return { agent_id: agentId, personal_space_id: spaceId, personal_project_id: 'sample-project',
    memory_scope: 'reviewed_agent', ...(updatedAt ? { updated_at: updatedAt } : {}),
    profile: { name, responsibility: 'Maintain the sample service.', status: 'active',
      allowed_clients: ['codex', 'cursor'],
      ...(legacy ? {} : { display_name: `${name} (display)`, capabilities: ['javascript'],
        character: { judgment: 'Prefers small verified steps.' }, expectations: 'Explain trade-offs.' }) },
    // Never projected: assignments, tokens and runtime details.
    assignments: [{ personal_project_id: 'private-other-project', task_context_token: 'fuli-task-secret' }] };
}

function memoryView(project, revision, summary, { spaceId = SPACE, agentId = 'engineer' } = {}) {
  return { personal_space_id: spaceId, personal_project_id: project, agent_id: agentId, revision,
    scope: project === null ? 'private_agent_global' : 'private_agent_project', storage: 'neo4j',
    current: revision ? { revision, agent_id: agentId, personal_project_id: project, created_at: '2026-10-13T08:00:00Z',
      source_session_id: 'synthetic-session-secret', task_id: 'synthetic-task',
      memory: { summary, decisions: ['Use the graph.'], next_actions: [] } } : null,
    history: [] };
}

// A Provider double: every request is recorded, and all writes are visible.
function provider({ agent = agentRecord(), memories = {}, onRequest = () => {} } = {}) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    requests.push({ method: options.method ?? 'GET', path: target.pathname, project: target.searchParams.get('personal_project_id') });
    onRequest(target, options);
    if (target.pathname === `/v1/project-agents/${agent.agent_id}`) return Response.json(agent);
    if (target.pathname === `/v1/project-agents/${agent.agent_id}/memory`) {
      if (options.method === 'PUT') {
        const input = JSON.parse(options.body);
        const key = input.personal_project_id ?? 'global';
        const revision = (memories[key]?.revision ?? 0) + 1;
        memories[key] = memoryView(input.personal_project_id, revision, input.memory.summary, { spaceId: agent.personal_space_id, agentId: agent.agent_id });
        return Response.json({ ...memories[key].current, checkpoint_id: `checkpoint-${revision}`,
          personal_space_id: agent.personal_space_id });
      }
      const project = target.searchParams.get('personal_project_id');
      return Response.json(memories[project ?? 'global'] ?? memoryView(project, 0, null, { spaceId: agent.personal_space_id, agentId: agent.agent_id }));
    }
    if (target.pathname === '/v1/project-agent-context/resolve') {
      return Response.json({ status: 'ready', reason: 'project_default', match_basis: [], agent });
    }
    if (target.pathname === '/v1/collaboration-preferences') {
      return Response.json({ personal_space_id: agent.personal_space_id, personal_project_id: 'sample-project',
        project_agent_id: agent.agent_id, conflicts: [], effective_preferences: [], agent_preferences: [] });
    }
    if (target.pathname === '/v1/personal-projects/sample-project') return Response.json({ profile: { name: 'Sample' } });
    if (target.pathname === '/v1/search') return Response.json({ facts: [], entities: [] });
    return Response.json([]);
  };
  return { fetchImpl, requests, memories };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'fuli-agent-snapshots-'));
  const root = join(home, 'data', 'agents');
  // The runtime data directory always exists beside its runtime config.
  mkdirSync(join(home, 'data'));
  let clock = Date.parse('2026-10-13T09:00:00Z');
  const locked = [];
  const app = (double, { spaceId = SPACE, providerUrl } = {}) => {
    const application = new FederatedGraphApplication(config(spaceId, providerUrl),
      { fetchImpl: double.fetchImpl, projectPathResolver: () => ({ status: 'matched', personalProjectId: 'sample-project' }) });
    application.agentSnapshots = createAgentDirectorySnapshots({ root,
      providerIdentity: providerUrl ?? 'http://127.0.0.1:8787', now: () => new Date(clock += 1000) });
    return application;
  };
  const files = (snapshot) => join(root, ...snapshot.path.split('/').slice(1));
  const read = (snapshot, file) => readFileSync(join(files(snapshot), file), 'utf8');
  const lock = (path) => { chmodSync(path, 0o500); locked.push(path); };
  const cleanup = () => {
    for (const path of locked) chmodSync(path, 0o700);
    rmSync(home, { recursive: true, force: true });
  };
  return { home, root, app, files, read, lock, cleanup };
}

const memoryInput = (personalProjectId = 'sample-project', spaceId = SPACE) =>
  ({ personalSpaceId: spaceId, personalProjectId, agentId: 'engineer', sourceApplication: 'codex' });
const projectFiles = (directory) => existsSync(join(directory, 'projects')) ? readdirSync(join(directory, 'projects')) : [];

test('a legacy Agent without a directory or optional fields gets a truthful snapshot on first authorized read, without DB writes', async () => {
  const { app, read, files, cleanup } = fixture();
  try {
    const double = provider({ agent: agentRecord({ legacy: true }) });
    const view = await callAgentTool(app(double), 'get_project_agent_memory', memoryInput());
    assert.equal(view.revision, 0);
    assert.equal(view.directorySnapshot.status, 'current');
    assert.match(view.directorySnapshot.path, /^agents\/[0-9a-f]{32}\/[0-9a-f]{32}\/[0-9a-f]{32}$/);
    assert.deepEqual(view.directorySnapshot.files.map(({ file, scope, state }) => [file.replace(/[0-9a-f]{32}/, 'P'), scope, state]),
      [['AGENTS.md', 'identity', 'written'], ['projects/P/MEMORY.md', 'project', 'written']]);
    assert.equal(double.requests.some(request => request.method !== 'GET'), false, 'no database write');
    const identity = read(view.directorySnapshot, 'AGENTS.md');
    assert.match(identity, /^# Engineer\n/);
    assert.match(identity, /not the authority/);
    assert.match(identity, /Maintain the sample service\./);
    const project = read(view.directorySnapshot, view.directorySnapshot.files[1].file);
    assert.match(project, /Database revision: 0/);
    assert.match(project, /No working memory has been recorded in this scope yet\./);
    assert.equal(statSync(files(view.directorySnapshot)).mode & 0o777, 0o700);
    assert.equal(statSync(join(files(view.directorySnapshot), 'AGENTS.md')).mode & 0o777, 0o600);
  } finally { cleanup(); }
});

test('global and project memory are separate files and private details never reach the artifacts', async () => {
  const { app, files, read, cleanup } = fixture();
  try {
    const double = provider({ memories: {
      global: memoryView(null, 5, 'Synthetic global working method.'),
      'sample-project': memoryView('sample-project', 3, 'Continue the sample migration.')
    } });
    const application = app(double);
    const project = await callAgentTool(application, 'get_project_agent_memory', memoryInput());
    const global = await callAgentTool(application, 'get_project_agent_memory', memoryInput(null));
    assert.equal(project.directorySnapshot.path, global.directorySnapshot.path, 'one directory per Agent');
    const globalText = read(global.directorySnapshot, 'MEMORY.md');
    const projectText = read(project.directorySnapshot, project.directorySnapshot.files[1].file);
    assert.match(globalText, /Scope: private_agent_global/);
    assert.match(globalText, /Database revision: 5/);
    assert.match(globalText, /Synthetic global working method\./);
    assert.equal(globalText.includes('sample migration'), false);
    assert.match(projectText, /Scope: private_agent_project/);
    assert.match(projectText, /Continue the sample migration\./);
    assert.equal(projectText.includes('global working method'), false);
    const everything = [globalText, projectText, read(project.directorySnapshot, 'AGENTS.md')].join('\n');
    for (const secret of ['synthetic-provider-token', 'fuli-task-secret', 'synthetic-session-secret',
      'private-other-project', 'synthetic-task', files(project.directorySnapshot)]) {
      assert.equal(everything.includes(secret), false, secret);
    }
    assert.equal(JSON.stringify(project.directorySnapshot).includes(files(project.directorySnapshot)), false, 'relative paths only');
    // Only the requested project was read; no other project memory was fetched.
    assert.deepEqual(double.requests.filter(request => request.path.endsWith('/memory')).map(request => request.project),
      ['sample-project', null]);
  } finally { cleanup(); }
});

test('spaces, providers and same-named Agents stay isolated, and a rename keeps the directory', async () => {
  const { app, read, cleanup } = fixture();
  try {
    const paths = new Set();
    for (const [spaceId, providerUrl, agentId] of [[SPACE, undefined, 'engineer'], ['other-space', undefined, 'engineer'],
      [SPACE, 'http://127.0.0.1:9797', 'engineer'], [SPACE, undefined, 'engineer-2']]) {
      const double = provider({ agent: agentRecord({ agentId, spaceId }) });
      const view = await callAgentTool(app(double, { spaceId, providerUrl }), 'get_project_agent_memory',
        { ...memoryInput('sample-project', spaceId), agentId });
      paths.add(view.directorySnapshot.path);
    }
    assert.equal(paths.size, 4);
    const renamed = provider({ agent: agentRecord({ name: 'Renamed Engineer', updatedAt: '2026-10-14T00:00:00Z' }) });
    const after = await callAgentTool(app(renamed), 'get_project_agent_memory', memoryInput());
    assert.equal(paths.has(after.directorySnapshot.path), true, 'stable ID-derived path');
    assert.match(read(after.directorySnapshot, 'AGENTS.md'), /^# Renamed Engineer \(display\)\n/);
  } finally { cleanup(); }
});

test('repeated reads are stable, deleted and edited artifacts are rebuilt from the database, unrelated files kept', async () => {
  const { app, files, read, cleanup } = fixture();
  try {
    const double = provider({ memories: { 'sample-project': memoryView('sample-project', 2, 'Database summary.') } });
    const application = app(double);
    const first = (await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot;
    const directory = files(first);
    const projectFile = first.files[1].file;
    const before = read(first, projectFile);
    const again = (await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot;
    assert.deepEqual(again.files.map(file => file.state), ['unchanged', 'unchanged']);
    assert.equal(read(first, projectFile), before, 'no rewrite when nothing changed');
    writeFileSync(join(directory, 'notes.md'), 'user notes');
    writeFileSync(join(directory, projectFile), '# edited\n\nForged summary.');
    rmSync(join(directory, 'AGENTS.md'));
    const rebuilt = (await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot;
    assert.deepEqual(rebuilt.files.map(file => file.state), ['written', 'written']);
    assert.match(read(first, projectFile), /Database summary\./);
    assert.equal(read(first, projectFile).includes('Forged'), false, 'edited Markdown is never imported');
    assert.equal(existsSync(join(directory, 'AGENTS.md')), true);
    assert.equal(readFileSync(join(directory, 'notes.md'), 'utf8'), 'user notes');
    for (const corrupt of ['not json', '{"version":1,"files":{"../escape":{"order":99}}}', '{"version":9}']) {
      writeFileSync(join(directory, '.fuli-snapshot.json'), corrupt);
      const recovered = (await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot;
      assert.equal(recovered.status, 'current');
      assert.match(read(first, projectFile), /Database summary\./);
    }
    assert.equal(double.requests.some(request => request.method !== 'GET'), false);
    assert.equal(double.memories['sample-project'].revision, 2, 'reads never change the revision');
    assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), []);
  } finally { cleanup(); }
});

test('an older revision never replaces a newer snapshot, and a busy writer is reported without waiting', async () => {
  const { app, files, read, cleanup } = fixture();
  try {
    const memories = { 'sample-project': memoryView('sample-project', 4, 'Revision four.') };
    const application = app(provider({ memories }));
    const current = (await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot;
    memories['sample-project'] = memoryView('sample-project', 3, 'Revision three, delayed.');
    const stale = (await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot;
    assert.equal(stale.status, 'newer_present');
    assert.equal(stale.files[1].state, 'newer_present');
    assert.match(read(current, current.files[1].file), /Revision four\./);
    // Even if the newer file was deleted, the older revision is not presented as latest.
    rmSync(join(files(current), current.files[1].file));
    assert.equal((await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot.files[1].state, 'newer_present');
    writeFileSync(join(files(current), '.fuli-snapshot.lock'), '');
    memories['sample-project'] = memoryView('sample-project', 5, 'Revision five.');
    const busy = await callAgentTool(application, 'get_project_agent_memory', memoryInput());
    assert.equal(busy.current.memory.summary, 'Revision five.', 'the database read still succeeds');
    assert.deepEqual(busy.directorySnapshot, { status: 'busy', path: current.path });
    assert.equal(existsSync(join(files(current), '.fuli-snapshot.lock')), true, 'another writer\'s lock is left alone');
  } finally { cleanup(); }
});

test('a committed memory write refreshes the snapshot; a task checkpoint marks it stale until the next read', async () => {
  const { app, read, cleanup } = fixture();
  try {
    const double = provider();
    const application = app(double);
    const written = await callAgentTool(application, 'checkpoint_project_agent_memory', { ...memoryInput(),
      expectedRevision: 0, idempotencyKey: 'snapshot-write-1', memory: { summary: 'Committed summary.' } });
    assert.equal(written.revision, 1);
    assert.equal(written.directorySnapshot.status, 'current');
    assert.match(read(written.directorySnapshot, written.directorySnapshot.files[1].file), /Committed summary\.[\s\S]*Database revision: 1|Database revision: 1[\s\S]*Committed summary\./);
    // A task checkpoint commits through the Provider without returning content.
    const marked = application.agentSnapshots.markStale({ personalSpaceId: SPACE, agentId: 'engineer',
      personalProjectId: 'sample-project', revision: 2 });
    assert.equal(marked.status, 'stale');
    double.memories['sample-project'] = memoryView('sample-project', 2, 'Task checkpoint summary.');
    const refreshed = (await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot;
    assert.equal(refreshed.status, 'current');
    assert.match(read(refreshed, refreshed.files[1].file), /Task checkpoint summary\./);
    // An older read than the marked revision reports stale rather than current.
    application.agentSnapshots.markStale({ personalSpaceId: SPACE, agentId: 'engineer', personalProjectId: 'sample-project', revision: 9 });
    assert.equal((await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot.status, 'stale');
    // The task checkpoint result carries the stale status; other results pass through unchanged.
    const task = withTaskMemorySnapshot(application, { status: 'checkpointed', personal_project_id: null,
      agent_memory: { status: 'checkpointed', agentId: 'engineer', revision: 6 } });
    assert.equal(task.agent_memory.directorySnapshot.status, 'stale');
    assert.equal(task.agent_memory.directorySnapshot.files[0].scope, 'global');
    const skipped = { status: 'checkpointed', agent_memory: { status: 'capture_disabled' } };
    assert.equal(withTaskMemorySnapshot(application, skipped), skipped);
  } finally { cleanup(); }
});

test('task entry projects the full scoped layers before preview trimming, never other projects', async () => {
  const { app, read, cleanup } = fixture();
  try {
    const long = `${'Long project memory. '.repeat(80)}END-OF-FULL-SUMMARY`;
    const double = provider({ memories: {
      global: memoryView(null, 5, 'Global method.'),
      'sample-project': { ...memoryView('sample-project', 3, long), current: { ...memoryView('sample-project', 3, long).current,
        memory: { summary: long, decisions: ['one', 'two', 'three', 'four', 'five'] } } }
    } });
    const result = await callAgentTool(app(double), 'get_collaboration_preferences', {
      projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.', sourceApplication: 'cursor' });
    const context = result.project_agent_context;
    const snapshot = context.directorySnapshot;
    assert.equal(snapshot.status, 'current');
    assert.deepEqual(snapshot.files.map(file => file.scope), ['identity', 'project', 'global']);
    const projectText = read(snapshot, snapshot.files[1].file);
    assert.match(projectText, /END-OF-FULL-SUMMARY/);
    assert.match(projectText, /- five/);
    assert.match(read(snapshot, 'MEMORY.md'), /Global method\./);
    assert.deepEqual(double.requests.filter(request => request.path.endsWith('/memory')).map(request => request.project).sort(),
      [null, 'sample-project'].sort());
    assert.equal(double.requests.some(request => request.method !== 'GET' && request.path.includes('memory')), false);
  } finally { cleanup(); }
});

test('unauthorized reads, task-only Agents and plain applications produce no snapshot', async () => {
  const { app, root, cleanup } = fixture();
  try {
    await assert.rejects(callAgentTool(app(provider()), 'get_project_agent_memory', { ...memoryInput(), sourceApplication: 'claude_code' }),
      /client is not allowed/);
    const taskOnly = provider({ agent: { ...agentRecord(), memory_scope: 'task_only' } });
    const context = (await callAgentTool(app(taskOnly), 'get_collaboration_preferences', {
      projectPath: '/synthetic/sample-project', taskPrompt: 'Continue.', sourceApplication: 'cursor' })).project_agent_context;
    assert.equal(context.directorySnapshot, undefined);
    assert.equal(existsSync(root), false);
    const plain = new FederatedGraphApplication(config(), { fetchImpl: provider().fetchImpl });
    const view = await callAgentTool(plain, 'get_project_agent_memory', memoryInput());
    assert.equal(view.directorySnapshot, undefined, 'no machine-global fallback without a runtime config');
  } finally { cleanup(); }
});

test('a delayed older stale mark keeps reporting the newer pending revision', () => {
  const { root, cleanup } = fixture();
  try {
    const snapshots = createAgentDirectorySnapshots({ root, providerIdentity: 'http://127.0.0.1:8787' });
    const agent = { agentId: 'engineer', memoryScope: 'reviewed_agent', profile: { name: 'Engineer' } };
    const scope = { personalSpaceId: SPACE, agentId: 'engineer', personalProjectId: 'sample-project' };
    snapshots.materialize({ personalSpaceId: SPACE, agent,
      layers: [{ personalProjectId: 'sample-project', revision: 3, current: null }] });
    assert.equal(snapshots.markStale({ ...scope, revision: 5 }).status, 'stale');
    const delayed = snapshots.markStale({ ...scope, revision: 2 });
    assert.equal(delayed.status, 'stale', 'revision 5 is still pending');
    assert.deepEqual(delayed.files.map(({ revision, state }) => [revision, state]), [[5, 'stale']]);
    // A mark at or below the projected revision with nothing pending stays current.
    snapshots.materialize({ personalSpaceId: SPACE, agent,
      layers: [{ personalProjectId: 'sample-project', revision: 5, current: null }] });
    assert.equal(snapshots.markStale({ ...scope, revision: 4 }).status, 'current');
  } finally { cleanup(); }
});

test('a Provider view whose current record names another Agent, project or revision is never projected', async () => {
  for (const [label, foreign] of [['agent', { agent_id: 'reviewer' }], ['project', { personal_project_id: 'private-other-project' }],
    ['space', { personal_space_id: 'other-space' }], ['revision', { revision: 9 }]]) {
    const { app, files, cleanup } = fixture();
    try {
      const view = memoryView('sample-project', 3, `FOREIGN-${label} content`);
      view.current = { ...view.current, ...foreign };
      const double = provider({ memories: { 'sample-project': view } });
      const result = await callAgentTool(app(double), 'get_project_agent_memory', memoryInput());
      // The database read itself is returned as before.
      assert.equal(result.revision, 3, label);
      assert.deepEqual(result.directorySnapshot.files.map(file => file.scope), ['identity'], label);
      assert.deepEqual(projectFiles(files(result.directorySnapshot)), [], `${label}: no project file is written`);
    } finally { cleanup(); }
  }
});

test('the owner console inspection creates and regenerates snapshots without the client allow-list', async () => {
  const { app, files, read, cleanup } = fixture();
  try {
    const agent = { ...agentRecord(), profile: { ...agentRecord().profile, allowed_clients: [] } };
    const double = provider({ agent, memories: { 'sample-project': memoryView('sample-project', 2, 'Owner-visible summary.') } });
    const application = app(double);
    const inspected = await application.inspectProjectAgentMemory({ personalSpaceId: SPACE,
      personalProjectId: 'sample-project', agentId: 'engineer', limit: 1 });
    assert.equal(inspected.current.memory.summary, 'Owner-visible summary.');
    assert.equal(inspected.directorySnapshot.status, 'current');
    const projectFile = inspected.directorySnapshot.files[1].file;
    assert.match(read(inspected.directorySnapshot, projectFile), /Owner-visible summary\./);
    rmSync(join(files(inspected.directorySnapshot), projectFile));
    const again = await application.inspectProjectAgentMemory({ personalSpaceId: SPACE,
      personalProjectId: 'sample-project', agentId: 'engineer', limit: 1 });
    assert.equal(again.directorySnapshot.files[1].state, 'written', 'a deleted file is rebuilt');
    assert.deepEqual(double.requests.filter(request => request.path.endsWith('/memory')).map(request => request.project),
      ['sample-project', 'sample-project'], 'no other project memory is fetched');
    assert.equal(double.requests.some(request => request.method !== 'GET'), false);
    // A task-only employee has no durable memory to project.
    const taskOnly = provider({ agent: { ...agent, memory_scope: 'task_only' } });
    const plain = await app(taskOnly).inspectProjectAgentMemory({ personalSpaceId: SPACE,
      personalProjectId: 'sample-project', agentId: 'engineer', limit: 1 });
    assert.equal(plain.directorySnapshot, undefined);
  } finally { cleanup(); }
});

test('symlinked managed paths are refused and never followed', async () => {
  const { app, files, home, cleanup } = fixture();
  try {
    const application = app(provider());
    const first = (await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot;
    const directory = files(first);
    const outside = join(home, 'outside.md');
    writeFileSync(outside, 'outside content');
    rmSync(join(directory, 'AGENTS.md'));
    symlinkSync(outside, join(directory, 'AGENTS.md'));
    const refused = await callAgentTool(application, 'get_project_agent_memory', memoryInput());
    assert.equal(refused.revision, 0, 'the database read still succeeds');
    assert.deepEqual(refused.directorySnapshot, { status: 'unsafe_path', path: first.path });
    assert.equal(readFileSync(outside, 'utf8'), 'outside content');
    // A symlinked Agent directory escaping the root is refused too.
    rmSync(directory, { recursive: true });
    mkdirSync(join(home, 'elsewhere'));
    symlinkSync(join(home, 'elsewhere'), directory);
    assert.equal((await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot.status, 'unsafe_path');
    assert.deepEqual(readdirSync(join(home, 'elsewhere')), []);
    assert.equal(lstatSync(directory).isSymbolicLink(), true, 'the user\'s link is left in place');
  } finally { cleanup(); }
});

test('read-only storage keeps the database result and reports a recoverable status', { skip: !permissionsEnforced }, async () => {
  const { app, files, lock, cleanup } = fixture();
  try {
    const memories = { 'sample-project': memoryView('sample-project', 1, 'First.') };
    const application = app(provider({ memories }));
    const first = (await callAgentTool(application, 'get_project_agent_memory', memoryInput())).directorySnapshot;
    lock(files(first));
    memories['sample-project'] = memoryView('sample-project', 2, 'Second.');
    const view = await callAgentTool(application, 'get_project_agent_memory', memoryInput());
    assert.equal(view.current.memory.summary, 'Second.');
    assert.deepEqual(view.directorySnapshot, { status: 'unavailable', path: first.path });
    assert.equal(JSON.stringify(view.directorySnapshot).includes('EACCES'), false, 'no raw filesystem error');
  } finally { cleanup(); }
});

test('the application factory attaches snapshots below the runtime data directory only', async () => {
  const { home, cleanup } = fixture();
  try {
    const dataDir = join(home, 'runtime-data');
    mkdirSync(dataDir);
    const runtimeConfigPath = join(dataDir, 'graph-runtime.json');
    writeFileSync(runtimeConfigPath, JSON.stringify(config()));
    const application = openFederatedGraphApplication({ runtimeConfigPath, env: {}, fetchImpl: provider().fetchImpl });
    const view = await callAgentTool(application, 'get_project_agent_memory', memoryInput());
    assert.equal(view.directorySnapshot.status, 'current');
    assert.equal(existsSync(join(dataDir, ...view.directorySnapshot.path.split('/'), 'AGENTS.md')), true);
  } finally { cleanup(); }
});
