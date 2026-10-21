// rec#5 C4: the places a person changes what FULI records. One switch per project
// for the console (C4-1), a confirmed preview before an Agent changes long-term
// settings (C4-2), an immediate session pause (C4-3) and one state seen by page and
// Agent alike (C4-4). The three clients are checked in test/capture-client-parity.test.js
// and test/agents/<id>/ (C4-5). Synthetic only: temporary directories and a
// recording Provider double. No FULI data directory, port-2727 service or client
// configuration is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { createCaptureChanges } from '../src/graphiti/capture-change-confirmation.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../src/graphiti/capture-policy.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { prepareDirectAgentToolCall } from '../src/mcp/direct-call.js';
import { codexEntry, confirmedCaptureChange, fixture, receiptOf } from './fixtures/capture-project-fixture.js';

const PROJECT_OFF = '此项目未开启记忆；你明确提交的修改仍会保存';
const NAMES = { 'job-hunt': '求职准备', thesis: '毕业论文', 'family-ledger': '家庭账本', novel: '小说连载' };

// The fixture with the names a person gave the projects.
async function namedFixture(t) {
  const f = await fixture(t);
  f.app.personal.listPersonalProjects = async () => [...f.projects].map(id => ({ project_id: id,
    profile: { name: NAMES[id] ?? id } }));
  return f;
}

// The preview an Agent was given, as the console link names it.
const previewIdOf = asked => asked.confirmUrl.split('/').at(-1);

const settingsOf = policy => ({ projectMode: policy.projectMode, excludedProjectIds: policy.excludedProjectIds,
  selectedProjectIds: policy.selectedProjectIds, unregisteredDirectories: policy.unregisteredDirectories });

async function api(f, method, body) {
  let sent;
  const request = { method, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
  const response = { writeHead: status => { sent = { status }; }, setHeader: () => {},
    end: text => { sent.body = JSON.parse(text); } };
  try {
    await handleGraphApiRequest({ request, response, url: new URL('http://127.0.0.1/api/capture-policy'), app: f.app });
  } catch (error) {
    return mapHttpError(error);
  }
  return sent;
}

test('C4-1 one project switch is applied to the settings it is saved with', async (t) => {
  const f = await fixture(t);
  // Every project recorded, stray folders skipped: switching one project off keeps the folder choice.
  f.store.update({ unregisteredDirectories: 'skip' });
  assert.deepEqual(settingsOf(f.store.update({ recordProjects: { 'family-ledger': false } })), { projectMode: 'all_except',
    excludedProjectIds: ['family-ledger'], selectedProjectIds: [], unregisteredDirectories: 'skip' });
  assert.deepEqual(f.store.update({ recordProjects: { novel: false } }).excludedProjectIds, ['family-ledger', 'novel']);
  assert.deepEqual(f.store.update({ recordProjects: { 'family-ledger': true } }).excludedProjectIds, ['novel']);

  // Only chosen projects: on adds to the list, off takes it out; both lists survive a mode switch.
  f.store.update({ projectMode: 'selected', selectedProjectIds: ['thesis'] });
  assert.deepEqual(f.store.update({ recordProjects: { novel: true, thesis: false } }).selectedProjectIds, ['novel']);
  assert.deepEqual(f.store.update({ projectMode: 'all_except' }).excludedProjectIds, ['novel']);

  for (const bad of [[], { thesis: 'off' }, {}, { 'a/b': false }]) {
    assert.throws(() => f.store.update({ recordProjects: bad }), TypeError);
  }
});

test('C4-1 switches apply to what the person sees; a list left from an earlier mode is not revived (dot review, PR 262)', (t) => {
  const store = new CapturePolicyStore(null);
  // Every project recorded, with an excluded list left over from an earlier all_except.
  store.update({ projectMode: 'all_except', excludedProjectIds: ['a'] });
  store.update({ projectMode: 'all' });
  assert.deepEqual(settingsOf(store.update({ recordProjects: { b: false } })).excludedProjectIds, ['b'],
    'turning b off excludes b alone');
  store.update({ projectMode: 'all' });
  assert.deepEqual(store.update({ recordProjects: { a: true, c: false } }).excludedProjectIds, ['c'], 'a stays recorded');
  store.update({ projectMode: 'all' });
  assert.equal(store.update({ recordProjects: { a: true } }).projectMode, 'all', 'turning on in all mode changes nothing');
});

test('C4-1 a switch saved while another process saved is merged into what that process saved (dot review, PR 262)', async (t) => {
  const f = await fixture(t);
  const path = capturePolicyPathForRuntime(f.runtimeConfigPath);
  // An Agent's MCP process and the console each have their own store on the same file.
  const agentProcess = new CapturePolicyStore(path);
  let interleaved = false;
  const consoleProcess = new CapturePolicyStore(path, { now: () => {
    // The Agent process saves after the console read the settings and before it writes.
    if (!interleaved) {
      interleaved = true;
      agentProcess.update({ recordProjects: { novel: false } });
    }
    return '2026-10-21T09:00:00.000Z';
  } });
  const saved = consoleProcess.update({ recordProjects: { thesis: false } });
  assert.equal(interleaved, true);
  assert.deepEqual(saved.excludedProjectIds, ['novel', 'thesis']);
  assert.deepEqual(new CapturePolicyStore(path).read().excludedProjectIds, ['novel', 'thesis'], 'nothing written back');
});

test('C4-1 the page switch saves at once, the settings list follows, and a refusal says why', async (t) => {
  const f = await fixture(t);
  const switched = await api(f, 'PATCH', { recordProjects: { 'family-ledger': false } });
  assert.equal(switched.status, 200);
  assert.deepEqual([switched.body.projectMode, switched.body.excludedProjectIds], ['all_except', ['family-ledger']]);
  // The settings page reads the same list.
  assert.deepEqual((await api(f, 'GET')).body.excludedProjectIds, ['family-ledger']);
  // The person's own switch needs no preview, and recording stops from the next turn.
  const entry = await codexEntry(f, f.dirs['family-ledger']);
  assert.ok(receiptOf(entry.context).endsWith(` · ${PROJECT_OFF}`));

  const refused = await api(f, 'PATCH', { recordProjects: { 'family-ledger': 'off' } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /recordProjects/);
  assert.deepEqual((await api(f, 'GET')).body.excludedProjectIds, ['family-ledger'], 'a refused switch changes nothing');
});

// The console routes of one capture change an Agent asked for.
async function consoleChange(f, method, previewId, action = '') {
  let sent;
  const request = { method, async *[Symbol.asyncIterator]() {} };
  const response = { writeHead: status => { sent = { status }; }, setHeader: () => {},
    end: text => { sent.body = JSON.parse(text); } };
  try {
    await handleGraphApiRequest({ request, response, app: f.app,
      url: new URL(`http://127.0.0.1/api/capture-changes/${previewId}${action ? `/${action}` : ''}`) });
  } catch (error) {
    return mapHttpError(error);
  }
  return sent;
}

const RESTART = '设置已变化，请重新发起';

test('C4-2 "这个项目以后别记了": the Agent gets FULI\'s sentence and a console link; only the console saves it', async (t) => {
  const f = await namedFixture(t);
  const current = await callAgentTool(f.app, 'get_capture_policy', { projectPath: f.dirs['job-hunt'],
    sourceApplication: 'codex' });
  const projectId = current.current.personalProjectId;
  assert.equal(projectId, 'job-hunt');
  const entry = await codexEntry(f, f.dirs.novel);

  const change = { recordProjects: { [projectId]: false } };
  const policyFile = capturePolicyPathForRuntime(f.runtimeConfigPath);
  const asked = await callAgentTool(f.app, 'update_capture_policy', { ...change, sourceApplication: 'codex',
    taskContextToken: entry.context.taskContextToken });
  assert.deepEqual(Object.keys(asked).sort(), ['confirmUrl', 'expiresAt', 'guidance', 'preview', 'status']);
  assert.equal(asked.status, 'confirmation_required');
  assert.equal(asked.preview, '将把『求职准备』加入不记录列表，之后在这个项目里的会话都不会被记录，已有记录保留。确认吗？');
  assert.match(asked.confirmUrl, /^http:\/\/127\.0\.0\.1:\d+\/capture-change\/[A-Za-z0-9_-]+$/);
  assert.match(asked.guidance, /You cannot complete this change/);
  await assert.rejects(readFile(policyFile), { code: 'ENOENT' }, 'asking saves nothing');

  // The console page shows the exact sentence, the change, the settings now and who asked.
  const previewId = previewIdOf(asked);
  const page = await consoleChange(f, 'GET', previewId);
  assert.equal(page.status, 200);
  assert.deepEqual([page.body.status, page.body.preview, page.body.sourceApplication, page.body.sessionId],
    ['pending', asked.preview, 'codex', 'synthetic-codex-session']);
  assert.deepEqual(page.body.changes, [
    { setting: 'projectMode', before: 'all', after: 'all_except' },
    { setting: 'excludedProjectIds', before: [], after: ['job-hunt'] }
  ]);
  assert.equal(page.body.current.projectMode, 'all');

  const confirmed = await consoleChange(f, 'POST', previewId, 'confirm');
  assert.equal(confirmed.status, 200);
  assert.deepEqual([confirmed.body.projectMode, confirmed.body.excludedProjectIds], ['all_except', ['job-hunt']]);
  // Applied once: the same link cannot apply it again.
  assert.deepEqual(await consoleChange(f, 'POST', previewId, 'confirm'),
    { status: 410, body: { error: RESTART, code: 'preview_expired' } });
  assert.ok(receiptOf((await codexEntry(f, f.dirs['job-hunt'])).context).endsWith(` · ${PROJECT_OFF}`));
});

test('C4-2 no Agent call completes a long-term change, through MCP or `fuli mcp --call`, in any later turn', async (t) => {
  const f = await namedFixture(t);
  const change = { recordProjects: { 'job-hunt': false } };
  const first = await codexEntry(f, f.dirs.novel);
  const asked = await callAgentTool(f.app, 'update_capture_policy', { ...change, sourceApplication: 'codex',
    taskContextToken: first.context.taskContextToken });
  const previewId = previewIdOf(asked);
  const update = listAgentTools().find(tool => tool.name === 'update_capture_policy');
  assert.equal(Object.keys(update.inputSchema.properties).some(name => /preview|confirm/i.test(name)), false);

  // The person's next message, the one after, and a task context the model began itself
  // through the public begin_task_context (dot review P1, PR 262): the Agent tries again with what it was given.
  const modelMade = await callAgentTool(f.app, 'begin_task_context', { sessionId: 'synthetic-codex-session',
    turnId: 'model-made-turn', projectPath: f.dirs.novel, taskPrompt: '确认', sourceApplication: 'codex' });
  for (const later of [await codexEntry(f, f.dirs.novel, { prompt: 'Turn 1: 确认' }),
    await codexEntry(f, f.dirs.novel, { prompt: 'Turn 2: 确认' }), { context: modelMade }]) {
    for (const input of [{ ...change, previewToken: previewId }, { ...change, confirm: true }, { previewId },
      { ...change, confirmUrl: asked.confirmUrl }]) {
      const payload = { ...input, taskContextToken: later.context.taskContextToken };
      await assert.rejects(callAgentTool(f.app, 'update_capture_policy', { ...payload, sourceApplication: 'codex' }),
        TypeError, 'fuli_call and the CLI dispatch here');
      await assert.rejects(prepareDirectAgentToolCall({ toolName: 'update_capture_policy', input: payload,
        sourceApplication: 'codex' }), TypeError, '`fuli mcp --call` validates against the same schema');
      assert.equal((await mcpCallResult(f.app, 'codex', 'update_capture_policy', payload)).isError, true);
    }
    // Asking again only makes another preview.
    assert.equal((await callAgentTool(f.app, 'update_capture_policy', { ...change, sourceApplication: 'codex' })).status,
      'confirmation_required');
  }
  assert.equal(f.store.read().projectMode, 'all', 'nothing an Agent sent was saved');
  assert.equal((await consoleChange(f, 'GET', previewId)).body.status, 'pending', 'the person can still decide');
});

test('C4-2 "只记这个项目" is restated with what else stops being recorded', async (t) => {
  const f = await namedFixture(t);
  const ask = input => callAgentTool(f.app, 'update_capture_policy', input);
  assert.equal((await ask({ projectMode: 'selected', selectedProjectIds: ['thesis'] })).preview,
    '将改为只记录『毕业论文』，其他项目里的会话都不会被记录；不属于任何 FULI 项目的目录不再记录，已有记录保留。确认吗？');
  assert.equal((await confirmedCaptureChange(f, { projectMode: 'selected', selectedProjectIds: ['thesis'] })).projectMode,
    'selected');
  assert.equal((await ask({ recordProjects: { novel: true } })).preview,
    '将把『小说连载』加入记录列表，之后在这个项目里的会话会被记录，已有记录保留。确认吗？');
  assert.equal((await ask({ enabled: false, disabledSources: ['cursor'] })).preview,
    '将关闭自动记录，所有客户端和项目都不再记录；不再记录 Cursor 的会话，已有记录保留。确认吗？');
  assert.deepEqual(await ask({ projectMode: 'selected' }),
    { status: 'unchanged', guidance: 'These settings are already in place; tell the user nothing needs to change.' });
});

test('C4-2 cancel, "不用了", expiry and a stale preview write nothing', async (t) => {
  const f = await namedFixture(t);
  const change = { recordProjects: { 'job-hunt': false } };
  const ask = async () => previewIdOf(await callAgentTool(f.app, 'update_capture_policy', change));

  // "不用了": the person never opens the link, or cancels it there.
  const declined = await ask();
  assert.deepEqual((await consoleChange(f, 'POST', declined, 'cancel')).body, { status: 'cancelled' });
  assert.deepEqual(await consoleChange(f, 'POST', declined, 'confirm'),
    { status: 410, body: { error: RESTART, code: 'preview_expired' } });
  assert.equal(f.store.version(), 'absent', 'no settings were written');

  // The settings changed after the Agent asked (the page, another request): the sentence no longer holds.
  const stale = await ask();
  f.store.update({ recordProjects: { novel: false } });
  assert.equal((await consoleChange(f, 'GET', stale)).body.status, 'stale');
  assert.deepEqual(await consoleChange(f, 'POST', stale, 'confirm'),
    { status: 409, body: { error: RESTART, code: 'preview_stale' } });

  // A preview expires.
  const clock = { now: Date.now() };
  f.app.captureChanges = createCaptureChanges(f.store, { listProjects: async () => [], now: () => clock.now,
    consoleUrl: 'http://127.0.0.1:4999', taskContext: async () => ({ sessionId: null }) });
  const late = await ask();
  clock.now += 30 * 60 * 1000;
  assert.equal((await consoleChange(f, 'GET', late)).status, 410);
  assert.equal((await consoleChange(f, 'POST', late, 'confirm')).status, 410);

  assert.deepEqual(f.store.read().excludedProjectIds, ['novel'], 'only the page change was saved');
  const stored = await readFile(join(dirname(f.store.path), 'capture-change-previews.json'), 'utf8');
  assert.equal(JSON.parse(stored).version, 1);
  for (const id of [declined, stale, late]) assert.equal(stored.includes(id), false, 'preview IDs are kept as hashes only');
});

test('C4-2 a console save that lands while the confirm runs wins, and the confirm says the settings changed', async (t) => {
  const f = await namedFixture(t);
  const previewId = previewIdOf(await callAgentTool(f.app, 'update_capture_policy', { recordProjects: { 'job-hunt': false } }));
  // Another console tab saves after the confirm checked the version and before its write takes the lock.
  const version = f.store.version.bind(f.store);
  let checks = 0;
  f.store.version = () => {
    const value = version();
    if (++checks === 1) f.store.update({ recordProjects: { novel: false } });
    return value;
  };
  assert.deepEqual(await consoleChange(f, 'POST', previewId, 'confirm'),
    { status: 409, body: { error: RESTART, code: 'preview_stale' } });
  f.store.version = version;
  assert.deepEqual(f.store.read().excludedProjectIds, ['novel'], 'the other save stays; the asked change is not saved');
});

test('C4-2 a preview an Agent\'s process made is confirmed through the console\'s process', async (t) => {
  const f = await namedFixture(t);
  const asked = await mcpCall(f.app, 'codex', 'update_capture_policy', { recordProjects: { 'job-hunt': false } });
  // The console runs its own application on the same runtime directory.
  const consoleApp = new FederatedGraphApplication(f.app.config, { runtimeConfigPath: f.runtimeConfigPath,
    capturePolicyStore: new CapturePolicyStore(capturePolicyPathForRuntime(f.runtimeConfigPath)),
    fetchImpl: async () => { throw new Error('No Provider in this test'); } });
  const saved = consoleApp.captureChanges.confirm(previewIdOf(asked));
  assert.deepEqual(saved.excludedProjectIds, ['job-hunt']);
});

test('C4-2 the sentence and the version it is bound to come from the same settings (dot review, PR 262)', async (t) => {
  const f = await namedFixture(t);
  // Only chosen projects; an excluded list (小说连载) left over from an earlier mode.
  f.store.update({ projectMode: 'all_except', excludedProjectIds: ['novel'] });
  f.store.update({ projectMode: 'selected', selectedProjectIds: ['thesis'] });
  // Another process changes that list while FULI words the request.
  const preview = f.store.preview.bind(f.store);
  let interleaved = false;
  f.store.preview = input => {
    const value = preview(input);
    if (!interleaved) {
      interleaved = true;
      f.store.update({ excludedProjectIds: ['job-hunt'] });
    }
    return value;
  };
  const asked = await callAgentTool(f.app, 'update_capture_policy', { projectMode: 'all_except' });
  f.store.preview = preview;
  assert.equal(interleaved, true);
  assert.equal(asked.preview, '将改为记录全部项目，『求职准备』除外；不属于任何 FULI 项目的目录也会记录，已有记录保留。确认吗？');
  const saved = f.app.captureChanges.confirm(previewIdOf(asked));
  assert.deepEqual([saved.projectMode, saved.excludedProjectIds], ['all_except', ['job-hunt']], 'what the sentence said');
});

test('C4-3 pausing this session stays immediate and changes no long-term setting', async (t) => {
  const f = await fixture(t);
  const entry = await codexEntry(f, f.dirs.novel);
  const paused = await callAgentTool(f.app, 'update_capture_policy', { sessionPaused: true,
    taskContextToken: entry.context.taskContextToken, sourceApplication: 'codex' });
  assert.equal(paused.status, 'session_paused');
  assert.equal(f.store.version(), 'absent', 'no long-term settings were written');
  // A pause never carries long-term settings, so it cannot skip their preview.
  await assert.rejects(callAgentTool(f.app, 'update_capture_policy', { sessionPaused: true, recordProjects: { novel: false },
    taskContextToken: entry.context.taskContextToken, sourceApplication: 'codex' }), TypeError);
});

test('C4-4 what the page saved is what the Agent reads next, in another process, with no stale copy', async (t) => {
  const f = await fixture(t);
  // The Agent's MCP process has its own store on the same file and has already read it once.
  const agentApp = new FederatedGraphApplication(f.app.config, { runtimeConfigPath: f.runtimeConfigPath,
    capturePolicyStore: new CapturePolicyStore(capturePolicyPathForRuntime(f.runtimeConfigPath)),
    fetchImpl: async () => { throw new Error('No Provider in this test'); } });
  agentApp.resolveProjectPath = f.app.resolveProjectPath.bind(f.app);
  assert.equal((await callAgentTool(agentApp, 'get_capture_policy', {})).projectMode, 'all');

  for (const [change, mode, captured] of [
    [{ projectMode: 'selected', selectedProjectIds: ['thesis'] }, 'selected', false],
    // Saved moments after the one before, under the same frozen clock.
    [{ projectMode: 'selected', selectedProjectIds: ['novel'] }, 'selected', true],
    [{ recordProjects: { novel: false } }, 'selected', false]
  ]) {
    const page = await api(f, 'PATCH', change);
    const agent = await callAgentTool(agentApp, 'get_capture_policy', { projectPath: f.dirs.novel, sourceApplication: 'codex' });
    assert.deepEqual(settingsOf(agent), settingsOf(page.body));
    assert.equal(agent.projectMode, mode);
    assert.equal(agent.current.captured, captured, JSON.stringify(change));
  }
});

// The MCP server a client starts for its Agent.
async function mcpCallResult(app, sourceApplication, name, args) {
  const server = createMcpServer(app, { env: {}, sourceApplication, registerResources: false });
  const client = new Client({ name: 'synthetic-capture-entry', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

async function mcpCall(app, sourceApplication, name, args) {
  const result = await mcpCallResult(app, sourceApplication, name, args);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent;
}
