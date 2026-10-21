import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';

// rec#20 quick edit through the local console's HTTP routes. Synthetic
// Provider: it records what the console sent and answers like the Provider.
const CONFIG = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
  accessToken: 'synthetic-token', principalId: 'synthetic-owner', spaceId: 'personal-space' } };

function application(reply = () => ({ status: 200, body: { ok: true } })) {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, { fetchImpl: async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const call = { path: url.pathname, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    const { status, body } = reply(call);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  } });
  return { app, calls };
}

function request(method, body) {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  return Object.assign(stream, { method, headers: { 'content-type': 'application/json' } });
}

async function api(app, method, path, body) {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  try {
    const handled = await handleGraphApiRequest({ request: request(method, body), response,
      url: new URL(`http://127.0.0.1${path}`), app });
    return { handled, ...sent };
  } catch (error) {
    return { handled: true, ...mapHttpError(error) };
  }
}

test('a receipt link opens one item: the console reads its authoritative view by kind and ID', async () => {
  const { app, calls } = application(() => ({ status: 200, body: { item_id: 'item/1', version: 4 } }));
  const result = await api(app, 'GET', '/api/knowledge/entity/item%2F1?personalSpaceId=personal-space');
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ path: '/v1/knowledge/item-views', method: 'POST',
    body: { personal_space_id: 'personal-space', item_kind: 'entity', item_id: 'item/1' } }]);
});

test('the link grants nothing: another space is refused before reaching the Provider', async () => {
  const { app, calls } = application();
  const result = await api(app, 'GET', '/api/knowledge/entity/item-1?personalSpaceId=someone-else');
  assert.equal(result.status, 400);
  assert.equal(calls.length, 0);
  const scope = await api(app, 'POST', '/api/knowledge/entity/item-1/scope', { personalSpaceId: 'someone-else',
    expectedVersion: 1, reason: 'mine', scope: 'global' });
  assert.equal(scope.status, 400);
  assert.equal(calls.length, 0);
});

test('a scope change names the version the page read and is the person\'s own edit', async () => {
  const { app, calls } = application(() => ({ status: 200, body: { scope: { kind: 'projects' } } }));
  const result = await api(app, 'POST', '/api/knowledge/relationship/item-1/scope', { personalSpaceId: 'personal-space',
    expectedVersion: 7, reason: 'Only for these two projects', scope: 'projects', projectIds: ['p1', 'p2', 'p1'],
    operationActor: 'agent' });
  assert.equal(result.status, 200);
  assert.deepEqual(calls[0], { path: '/v1/knowledge/items/item-1/scope', method: 'POST', body: {
    personal_space_id: 'personal-space', item_kind: 'relationship', expected_version: 7,
    reason: 'Only for these two projects', scope: 'projects', project_ids: ['p1', 'p2'], agent_id: null,
    operation_actor: 'human' } });
  for (const body of [{ expectedVersion: undefined }, { expectedVersion: -1 }, { scope: 'everywhere' }, { reason: ' ' }]) {
    const refused = await api(app, 'POST', '/api/knowledge/entity/item-1/scope', { personalSpaceId: 'personal-space',
      expectedVersion: 1, reason: 'r', scope: 'global', ...body });
    assert.equal(refused.status, 400);
  }
  assert.equal(calls.length, 1);
});

test('an edit from a stale page comes back as a conflict the page can explain', async () => {
  const { app } = application(() => ({ status: 409, body: { detail: { code: 'stale_version', current_version: 9,
    message: 'knowledge changed since it was read; read it again before editing' } } }));
  const scope = await api(app, 'POST', '/api/knowledge/entity/item-1/scope', { personalSpaceId: 'personal-space',
    expectedVersion: 3, reason: 'r', scope: 'global' });
  assert.equal(scope.status, 409);
  assert.equal(scope.body.code, 'stale_version');
  const content = await api(app, 'PATCH', '/api/knowledge/entity/item-1', { personalSpaceId: 'personal-space',
    action: 'update', reason: 'fix wording', name: 'New wording', expectedVersion: 3 });
  assert.equal(content.status, 409);
  assert.equal(content.body.code, 'stale_version');
});

test('content edits and deactivation send the version the page read', async () => {
  const { app, calls } = application(() => ({ status: 200, body: { id: 'revision' } }));
  await api(app, 'PATCH', '/api/knowledge/entity/item-1', { personalSpaceId: 'personal-space', action: 'invalidate',
    reason: 'No longer true', expectedVersion: 5 });
  assert.equal(calls[0].body.expected_version, 5);
  assert.equal(calls[0].body.action, 'invalidate');
  assert.equal(calls[0].body.operation_actor, 'human');
});

test('a long receipt\'s full list reads every episode it links, in the Provider\'s batches', async () => {
  const { app, calls } = application(call => ({ status: 200, body: { unchanged_count: 1,
    entries: call.body.episode_ids.map(id => ({ item_kind: 'entity', item_id: `item-${id}` })) } }));
  const result = await api(app, 'GET', '/api/knowledge/turn-receipt?personalSpaceId=personal-space&episodes=e1,e2,e3,e4,e5');
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map(call => call.body.episode_ids), [['e1', 'e2', 'e3'], ['e4', 'e5']]);
  assert.deepEqual(result.body.entries.map(entry => entry.item_id), ['item-e1', 'item-e2', 'item-e3', 'item-e4', 'item-e5']);
  assert.equal(result.body.unchanged_count, 2);
  const none = await api(app, 'GET', '/api/knowledge/turn-receipt?personalSpaceId=personal-space&episodes=');
  assert.equal(none.status, 400);
});

test('scope changes are a local person\'s decision, never an Agent tool', () => {
  const entry = agentInterfaceCatalog().uiMutationParity
    .find(item => item.route === 'POST /api/knowledge/:itemKind/:itemId/scope');
  assert.equal(entry.access, 'local_user_only');
});
