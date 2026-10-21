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

import { callAgentTool } from '../src/agent-tools.js';
import { createCaptureChanges } from '../src/graphiti/capture-change-confirmation.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../src/graphiti/capture-policy.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
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

test('C4-2 "这个项目以后别记了": FULI words the exact change and saves it only after the person confirms', async (t) => {
  const f = await namedFixture(t);
  const current = await callAgentTool(f.app, 'get_capture_policy', { projectPath: f.dirs['job-hunt'],
    sourceApplication: 'codex' });
  const projectId = current.current.personalProjectId;
  assert.equal(projectId, 'job-hunt');

  const policyFile = capturePolicyPathForRuntime(f.runtimeConfigPath);
  const preview = await callAgentTool(f.app, 'update_capture_policy', { recordProjects: { [projectId]: false },
    sourceApplication: 'codex' });
  assert.equal(preview.status, 'confirmation_required');
  assert.equal(preview.preview, '将把『求职准备』加入不记录列表，之后在这个项目里的会话都不会被记录，已有记录保留。确认吗？');
  assert.match(preview.guidance, /word for word/);
  await assert.rejects(readFile(policyFile), { code: 'ENOENT' }, 'a preview saves nothing');
  assert.equal(f.store.read().projectMode, 'all');

  const saved = await callAgentTool(f.app, 'update_capture_policy', { recordProjects: { [projectId]: false },
    previewToken: preview.previewToken, sourceApplication: 'codex' });
  assert.deepEqual([saved.projectMode, saved.excludedProjectIds], ['all_except', ['job-hunt']]);
  assert.ok(receiptOf((await codexEntry(f, f.dirs['job-hunt'])).context).endsWith(` · ${PROJECT_OFF}`));
});

test('C4-2 "只记这个项目" is restated with what else stops being recorded', async (t) => {
  const f = await namedFixture(t);
  const preview = await callAgentTool(f.app, 'update_capture_policy', { projectMode: 'selected',
    selectedProjectIds: ['thesis'] });
  assert.equal(preview.preview, '将改为只记录『毕业论文』，其他项目里的会话都不会被记录；不属于任何 FULI 项目的目录不再记录，已有记录保留。确认吗？');
  const resumed = await confirmedCaptureChange(f, { projectMode: 'selected', selectedProjectIds: ['thesis'] });
  assert.equal(resumed.projectMode, 'selected');
  assert.equal((await callAgentTool(f.app, 'update_capture_policy', { recordProjects: { novel: true } })).preview,
    '将把『小说连载』加入记录列表，之后在这个项目里的会话会被记录，已有记录保留。确认吗？');
  assert.equal((await callAgentTool(f.app, 'update_capture_policy', { enabled: false, disabledSources: ['cursor'] })).preview,
    '将关闭自动记录，所有客户端和项目都不再记录；不再记录 Cursor 的会话，已有记录保留。确认吗？');
  assert.deepEqual(await callAgentTool(f.app, 'update_capture_policy', { projectMode: 'selected' }),
    { status: 'unchanged', guidance: 'These settings are already in place; tell the user nothing needs to change.' });
});

test('C4-2 "不用了" changes nothing, and no call without the confirmed preview can save', async (t) => {
  const f = await namedFixture(t);
  const change = { recordProjects: { 'job-hunt': false } };
  const declined = await callAgentTool(f.app, 'update_capture_policy', change);
  // The person declined: the Agent does not call again. Nothing was saved.
  assert.equal(f.store.version(), 'absent');

  const attempts = [
    [{ ...change, previewToken: 'made-up-token' }, 'preview_expired'],
    [{ recordProjects: { thesis: false }, previewToken: declined.previewToken }, 'preview_mismatch'],
    // Each token is used once, whatever the outcome.
    [{ ...change, previewToken: declined.previewToken }, 'preview_expired']
  ];
  for (const [input, code] of attempts) {
    await assert.rejects(callAgentTool(f.app, 'update_capture_policy', input), { code });
  }
  // Another client cannot use the preview a client was given.
  const codex = await callAgentTool(f.app, 'update_capture_policy', { ...change, sourceApplication: 'codex' });
  await assert.rejects(callAgentTool(f.app, 'update_capture_policy', { ...change, sourceApplication: 'cursor',
    previewToken: codex.previewToken }), { code: 'preview_expired' });
  // Settings that changed after the preview (the page, another Agent) need a new preview.
  const stale = await callAgentTool(f.app, 'update_capture_policy', change);
  f.store.update({ recordProjects: { novel: false } });
  await assert.rejects(callAgentTool(f.app, 'update_capture_policy', { ...change, previewToken: stale.previewToken }),
    { code: 'preview_stale' });
  // A preview expires.
  const clock = { now: Date.now() };
  f.app.captureChanges = createCaptureChanges(f.store, { listProjects: async () => [], now: () => clock.now });
  const late = await callAgentTool(f.app, 'update_capture_policy', change);
  clock.now += 10 * 60 * 1000;
  await assert.rejects(callAgentTool(f.app, 'update_capture_policy', { ...change, previewToken: late.previewToken }),
    { code: 'preview_expired' });

  assert.deepEqual(f.store.read().excludedProjectIds, ['novel'], 'only the page change was saved');
  const stored = await readFile(join(dirname(f.store.path), 'capture-change-previews.json'), 'utf8');
  for (const token of [declined.previewToken, codex.previewToken, late.previewToken]) {
    assert.equal(stored.includes(token), false, 'tokens are kept as hashes only');
  }
});

test('C4-2 a preview made through one FULI process is confirmed through another, over MCP', async (t) => {
  const f = await namedFixture(t);
  const change = { recordProjects: { 'job-hunt': false } };
  const preview = await mcpCall(f.app, 'codex', 'update_capture_policy', change);
  assert.equal(preview.status, 'confirmation_required');

  // A second process on the same runtime directory, as `fuli mcp --call` or a restarted client starts.
  const other = new FederatedGraphApplication(f.app.config, { runtimeConfigPath: f.runtimeConfigPath,
    capturePolicyStore: new CapturePolicyStore(capturePolicyPathForRuntime(f.runtimeConfigPath)),
    fetchImpl: async () => { throw new Error('No Provider in this test'); } });
  const saved = await mcpCall(other, 'codex', 'update_capture_policy', { ...change, previewToken: preview.previewToken });
  assert.deepEqual(saved.excludedProjectIds, ['job-hunt']);
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
async function mcpCall(app, sourceApplication, name, args) {
  const server = createMcpServer(app, { env: {}, sourceApplication, registerResources: false });
  const client = new Client({ name: 'synthetic-capture-entry', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent;
  } finally {
    await client.close();
    await server.close();
  }
}
