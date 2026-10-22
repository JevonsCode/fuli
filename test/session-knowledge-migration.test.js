import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { beginTaskFromPreferences } from '../src/graphiti/agent-knowledge-workflows.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { sessionMigrationLine, sessionMigrationOffer } from '../src/graphiti/session-knowledge-migration.js';
import { ensureSessionTemporaryProject } from '../src/graphiti/temporary-project-scope.js';
import { checkpointTurnReceipt } from '../src/graphiti/turn-receipt-delivery.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { handleKnowledgeScopeRequest } from '../src/http/knowledge-scope-api-router.js';
import { knowledgeScopeConsole } from '../src/knowledge-scope/console-port.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { reachableModules } from '../test-support/module-graph.js';

// rec#20 part 2: a session's batch migration from its temporary project into
// the formal project it linked to. Synthetic Provider only.
const CONFIG = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
  accessToken: 'synthetic-token', principalId: 'synthetic-owner', spaceId: 'personal-space' } };
const CONSOLE = 'http://127.0.0.1:3999';
const SESSION = '0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b84';

function application(reply = () => ({ status: 200, body: { ok: true } })) {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, { fetchImpl: async (rawUrl, options = {}) => {
    const call = { path: new URL(rawUrl).pathname, body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    const { status, body } = reply(call);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  } });
  // The migration leaves on the console's human-review channel (rec#11 D-22).
  app.scopeConsole = knowledgeScopeConsole('synthetic-data-dir', { send: async (path, body, { review }) => {
    const call = { path, body, review };
    calls.push(call);
    const { status, body: payload } = reply(call);
    return { ok: status < 400, status, payload };
  } });
  return { app, calls };
}

async function api(app, method, path, body, remoteAddress = '127.0.0.1') {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  const request = Object.assign(stream, { method, headers: { 'content-type': 'application/json' },
    socket: { remoteAddress } });
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  try {
    const url = new URL(`http://127.0.0.1${path}`);
    await handleKnowledgeScopeRequest({ request, response, url, app, scopeConsole: app.scopeConsole })
      || await handleGraphApiRequest({ request, response, url, app });
    return sent;
  } catch (error) {
    return mapHttpError(error);
  }
}

const migration = { personalSpaceId: 'personal-space', sourceApplication: 'codex', sessionId: SESSION, projectId: 'alpha',
  reason: 'This session belongs to Alpha', items: [{ itemKind: 'entity', itemId: 'item-1', expectedVersion: 2 },
    { itemKind: 'relationship', itemId: 'item-2', expectedVersion: 0 }] };

test('the console reads what the session holds for the project it linked to', async () => {
  const { app, calls } = application(() => ({ status: 200, body: { held_count: 2, items: [] } }));
  const result = await api(app, 'GET', `/api/knowledge/session-migration?personalSpaceId=personal-space&client=codex&sessionId=${SESSION}&projectId=alpha`);
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ path: '/v1/knowledge/session-migrations/preview', body: { personal_space_id: 'personal-space',
    source_application: 'codex', session_id: SESSION, target_project_id: 'alpha', include_items: true, offset: 0 } }]);
  const other = await api(app, 'GET', `/api/knowledge/session-migration?personalSpaceId=someone-else&client=codex&sessionId=${SESSION}&projectId=alpha`);
  assert.equal(other.status, 400);
  assert.equal(calls.length, 1, 'another space is refused before the Provider');
});

test('the person\'s chosen items move with the versions the page showed, as their own console action', async () => {
  const { app, calls } = application(() => ({ status: 200, body: { target_project_id: 'alpha', moved: [] } }));
  const result = await api(app, 'POST', '/api/knowledge/session-migration', { ...migration, operationActor: 'agent' });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ path: '/v1/knowledge/session-migrations/apply', review: true, body: { personal_space_id: 'personal-space',
    source_application: 'codex', session_id: SESSION, target_project_id: 'alpha', reason: 'This session belongs to Alpha',
    items: [{ item_kind: 'entity', item_id: 'item-1', expected_version: 2 },
      { item_kind: 'relationship', item_id: 'item-2', expected_version: 0 }], operation_actor: 'human' } }]);
  for (const change of [{ items: [] }, { items: [{ itemKind: 'entity', itemId: 'x' }] },
    { items: [migration.items[0], migration.items[0]] }, { reason: ' ' }, { projectId: undefined },
    { items: Array.from({ length: 101 }, (_, index) => ({ itemKind: 'entity', itemId: `i${index}`, expectedVersion: 0 })) }]) {
    assert.equal((await api(app, 'POST', '/api/knowledge/session-migration', { ...migration, ...change })).status, 400);
  }
  assert.equal(calls.length, 1);
});

test('a migration is confirmed only on this computer and never by an Agent tool', async () => {
  const { app, calls } = application();
  const remote = await api(app, 'POST', '/api/knowledge/session-migration', migration, '192.168.1.20');
  assert.equal(remote.status, 403);
  assert.equal(remote.body.code, 'local_user_only');
  assert.equal(calls.length, 0);
  const entry = agentInterfaceCatalog().uiMutationParity.find(item => item.route === 'POST /api/knowledge/session-migration');
  assert.equal(entry.access, 'local_user_only');
  assert.ok(!JSON.stringify(listAgentTools()).includes('session-migration'));
  // No MCP or Agent tool module reaches the port, the router or the channel that posts it.
  const writing = ['src/knowledge-scope/console-port.js', 'src/http/knowledge-scope-api-router.js',
    'src/graphiti/human-review-channel.js'].map(path => join(ROOT, path));
  for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachableModules(join(ROOT, entry));
    assert.deepEqual(writing.filter(path => modules.has(path)), [], entry);
  }
  // Without a local installation there is no human-review channel: nothing is sent.
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = JSON.parse(text); } };
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(migration))]), { method: 'POST',
    headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } });
  await handleKnowledgeScopeRequest({ request, response, url: new URL('http://127.0.0.1/api/knowledge/session-migration'),
    app, scopeConsole: null });
  assert.equal(sent.status, 503);
  assert.equal(calls.length, 0);
});

test('a refused batch comes back as a conflict naming its items, which the page marks', async () => {
  const { app } = application(() => ({ status: 409, body: { detail: { code: 'stale_version',
    stale_items: [{ item_kind: 'entity', item_id: 'item-1', reason: 'changed' }],
    message: 'some items changed since the migration was shown; nothing moved, read it again' } } }));
  const result = await api(app, 'POST', '/api/knowledge/session-migration', migration);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'stale_version');
  assert.deepEqual(result.body.items, [{ item_kind: 'entity', item_id: 'item-1', reason: 'changed' }]);
  const match = application(() => ({ status: 409, body: { detail: { code: 'project_has_match',
    items: [{ item_kind: 'entity', item_id: 'item-2' }], message: 'the target already holds a conflicting item' } } }));
  const refused = await api(match.app, 'POST', '/api/knowledge/session-migration', migration);
  assert.deepEqual([refused.status, refused.body.code, refused.body.items], [409, 'project_has_match',
    [{ item_kind: 'entity', item_id: 'item-2' }]]);
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the session temporary project is keyed like the Provider finds it', async () => {
  const asked = [];
  const app = { config: { personal: { spaceId: 'space-a' } }, personal: { ensureTemporaryProject: async input => {
    asked.push(input);
    return { project_id: `temporary-${input.scope_key}`, scope_type: 'temporary' };
  } } };
  // graph-provider/tests/test_temporary_project_scope.py checks the same vector.
  assert.equal(await ensureSessionTemporaryProject(app, { sourceApplication: 'codex', sessionId: '会话-1' }),
    'temporary-3a6448da65186aee8b8b66a7aaa191a0cee4911d8c8461c6c41cf3888f0e3317');
  assert.equal(asked[0].lifetime, 'session');
});

function entryApp(pending) {
  const asked = [];
  return { asked, app: { consoleUrl: CONSOLE, config: { personal: { spaceId: 'personal-space' } }, personal: {
    previewSessionMigration: async input => {
      asked.push(input);
      if (pending instanceof Error) throw pending;
      return pending;
    } } } };
}

const task = { sessionId: SESSION, sourceApplication: 'claude_code', personalProjectId: 'alpha', token: 'fuli-task-x' };
const LINK = `[确认迁移](<${CONSOLE}/s/${SESSION}/migrate?client=claude_code&project=alpha>)`;

test('the session\'s first task in a formal project links the person to the migration while items wait', async () => {
  const { app, asked } = entryApp({ held_count: 3, linked_task_count: 1 });
  assert.equal(await sessionMigrationOffer(app, task),
    `FULI 待迁移：本会话临时项目有 3 条范围待确定，迁入当前项目需你确认：${LINK}`);
  assert.deepEqual(asked, [{ personal_space_id: 'personal-space', source_application: 'claude_code', session_id: SESSION,
    target_project_id: 'alpha', include_items: false }]);
  // Nothing waits, a later task of the session, a temporary task, or a failed read: no line, no failed entry.
  assert.equal(await sessionMigrationOffer(entryApp({ held_count: 0, linked_task_count: 1 }).app, task), null);
  assert.equal(await sessionMigrationOffer(entryApp({ held_count: 3, linked_task_count: 2 }).app, task), null);
  assert.equal(await sessionMigrationOffer(entryApp(new Error('down')).app, task), null);
  const temporary = entryApp({ held_count: 3, linked_task_count: 1 });
  assert.equal(await sessionMigrationOffer(temporary.app, { ...task, personalProjectId: `temporary-${'a'.repeat(64)}` }), null);
  assert.equal(temporary.asked.length, 0, 'a temporary task asks nothing');
});

test('a turn in a formal project that left items undecided links its receipt to the migration', async () => {
  const held = { item_kind: 'entity', item_id: 'held-1', category: 'fact', content: 'Synthetic held fact', tags: [],
    scope: { kind: 'temporary', projects: [{ id: 'temporary-x', temporary: true }], status: 'undetermined' },
    confirmation_status: 'pending', content_source: 'agent_inferred' };
  const app = { consoleUrl: CONSOLE, config: { personal: { spaceId: 'personal-space' } },
    personal: { readTurnReceipt: async () => ({ entries: [held], unchanged_count: 0 }) },
    taskContextRegistry: { claimTurnReceipt: async () => true } };
  const results = (scope, status = 'committed') => [{ scope, status, episode_id: 'episode-1', entity_ids: ['held-1'] }];
  const lines = async (overrides, captureResults) => (await checkpointTurnReceipt(app, { ...task, ...overrides,
    checkpoint: { captureResults } })).lines;
  assert.equal((await lines({}, results('session_temporary'))).at(-1),
    `FULI 待迁移：本轮有条目暂存在本会话临时项目，迁入当前项目需你确认：${LINK}`);
  for (const [overrides, captured] of [[{}, results('current_project')],
    [{ personalProjectId: `temporary-${'b'.repeat(64)}` }, results('session_temporary')], [{ personalProjectId: null }, results('session_temporary')]]) {
    assert.doesNotMatch((await lines(overrides, captured)).join('\n'), /待迁移/);
  }
});

test('the offer follows the entry receipt the Agent copies, after a late receipt', async () => {
  const { app } = entryApp({ held_count: 2, linked_task_count: 1 });
  const entry = await beginTaskFromPreferences({ ...app, taskContextRegistry: { begin: async () => ({ ...task,
    unreadTurnReceipts: [] }) }, personal: { ...app.personal, conversation: async () => ({ status: 'saved' }) } },
  { context: { personal_project_id: 'alpha', project_agent_id: null }, effective_preferences: [],
    agent_receipt: { required: true, markdown: 'FULI Agent：负责人 X' } }, { sessionId: SESSION, sourceApplication: 'claude_code' });
  assert.equal(entry.agent_receipt.markdown, `FULI Agent：负责人 X\n${sessionMigrationLine(app, task, { heldCount: 2 })}`);
});
