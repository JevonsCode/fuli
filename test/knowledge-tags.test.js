import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { normalizeAgentSessionInput } from '../src/mcp/session-id.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';

// Synthetic Provider boundary: the tools must send the Provider contract and
// keep Agent attribution; the vocabulary rules themselves are Provider tests.
const CONFIG = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
  accessToken: 'synthetic-token', principalId: 'synthetic-owner', spaceId: 'personal-space' } };

function application() {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, { fetchImpl: async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({ path: url.pathname, method: options.method ?? 'GET',
      body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ outcome: 'synthetic' }), { status: 200,
      headers: { 'content-type': 'application/json' } });
  } });
  return { app, calls };
}

const definitions = () => new Map(listAgentTools().map((tool) => [tool.name, tool]));
const space = { personalSpaceId: 'personal-space' };

test('an Agent resolves before it creates, through two compact tools', async () => {
  const tools = definitions();
  const resolve = tools.get('resolve_knowledge_tags');
  const change = tools.get('change_knowledge_tags');
  assert.match(resolve.title, /^READ/);
  assert.match(change.title, /^WRITE/);
  assert.deepEqual(change.inputSchema.properties.action.enum, ['create', 'add_alias', 'attach', 'detach']);
  assert.deepEqual(change.inputSchema.properties.namespace.enum, ['personal', 'project'],
    'shared vocabulary changes are not offered to Agents');
  assert.equal(change.inputSchema.properties.operationActor, undefined);
  assert.match(resolve.description, /Similarity is lexical only; record a synonym with add_alias\./);
  assert.match(change.description, /else namespace personal/);
  for (const tool of [resolve, change]) {
    assert.ok(Buffer.byteLength(JSON.stringify(tool)) < 1500, `${tool.name} stays compact`);
  }

  const { app, calls } = application();
  const query = { ...space, personalProjectId: 'nature-class', query: '野外教学', limit: 3 };
  assert.equal(jsonSchemaToZod(resolve.inputSchema).safeParse(query).success, true);
  await callAgentTool(app, 'resolve_knowledge_tags', query);
  const create = { ...space, personalProjectId: 'nature-class', action: 'create', name: '自然笔记',
    description: '观察时的图文记录', reason: '课程首次加入自然笔记', distinctFrom: ['tag-a'] };
  assert.equal(jsonSchemaToZod(change.inputSchema).safeParse(create).success, true);
  await callAgentTool(app, 'change_knowledge_tags', { ...create, operationActor: 'human' });
  await callAgentTool(app, 'change_knowledge_tags', { ...space, action: 'add_alias', tagId: 'tag-a',
    alias: '野外教学', reason: '同义' });
  await callAgentTool(app, 'change_knowledge_tags', { ...space, personalProjectId: 'nature-class',
    action: 'attach', tagId: 'tag-a', itemKind: 'entity', itemId: 'item-1' });
  await callAgentTool(app, 'change_knowledge_tags', { ...space, action: 'detach', tagId: 'tag-a',
    itemKind: 'relationship', itemId: 'edge-1' });

  assert.deepEqual(calls.map(({ path, method }) => `${method} ${path}`), [
    'POST /v1/knowledge-tags/resolve', 'POST /v1/knowledge-tags/create', 'POST /v1/knowledge-tags/aliases',
    'POST /v1/knowledge-tags/attach', 'POST /v1/knowledge-tags/detach']);
  assert.deepEqual(calls[0].body, { personal_space_id: 'personal-space', personal_project_id: 'nature-class',
    query: '野外教学', limit: 3 });
  assert.deepEqual(calls[1].body, { personal_space_id: 'personal-space', personal_project_id: 'nature-class',
    name: '自然笔记', description: '观察时的图文记录', namespace: null, language: null,
    reason: '课程首次加入自然笔记', distinct_from: ['tag-a'], operation_actor: 'agent' });
  assert.deepEqual(calls[2].body, { personal_space_id: 'personal-space', personal_project_id: null,
    tag_id: 'tag-a', alias: '野外教学', reason: '同义', operation_actor: 'agent' });
  assert.deepEqual(calls[3].body, { personal_space_id: 'personal-space', personal_project_id: 'nature-class',
    tag_id: 'tag-a', item_kind: 'entity', item_id: 'item-1', operation_actor: 'agent' });
  assert.equal(calls[4].body.item_kind, 'relationship');
});

test('the MCP process names the client, and recording-off stops every tag write', async () => {
  const input = normalizeAgentSessionInput('change_knowledge_tags',
    { ...space, action: 'create', name: 'x', reason: 'y', sourceApplication: 'cursor' }, null, null,
    () => new Date(), 'claude_code');
  assert.equal(input.sourceApplication, 'claude_code');

  const { app, calls } = application();
  await callAgentTool(app, 'change_knowledge_tags', { ...input });
  assert.equal(calls[0].body.source_application, 'claude_code');
  await app.updateCapturePolicy({ enabled: false });
  const skipped = await callAgentTool(app, 'change_knowledge_tags', { ...input, name: 'z' });
  assert.equal(skipped.route, 'disabled');
  assert.match(skipped.guidance, /nothing from this call was saved/);
  // Reads are not recording and stay available.
  await callAgentTool(app, 'resolve_knowledge_tags', { ...space, query: 'z' });
  assert.deepEqual(calls.map(({ path }) => path), ['/v1/knowledge-tags/create', '/v1/knowledge-tags/resolve']);
});

test('unknown tag operations and other personal spaces are refused before the Provider', async () => {
  const { app, calls } = application();
  await assert.rejects(callAgentTool(app, 'change_knowledge_tags', { ...space, action: 'merge', tagId: 'a' }),
    /Unknown knowledge tag operation/);
  await assert.rejects(callAgentTool(app, 'resolve_knowledge_tags', { personalSpaceId: 'other', query: 'a' }),
    /active personal space/);
  assert.deepEqual(calls, []);
});

function request(method, path, body) {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  return Object.assign(stream, { method, headers: { 'content-type': 'application/json' } });
}

async function api(app, method, path, body) {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  const handled = await handleGraphApiRequest({ request: request(method, path, body), response,
    url: new URL(`http://127.0.0.1${path}`), app });
  return { handled, ...sent };
}

test('the local console reads and changes tags as the person', async () => {
  const { app, calls } = application();
  assert.equal((await api(app, 'GET',
    '/api/knowledge-tags?personalSpaceId=personal-space&personalProjectId=p1&q=%E6%88%B7%E5%A4%96&limit=4')).status, 200);
  await api(app, 'GET', '/api/knowledge-tags/metrics?personalSpaceId=personal-space&allProjects=true&days=7');
  await api(app, 'POST', '/api/knowledge-tags', { ...space, action: 'create', name: '户外学习', reason: 'mine',
    namespace: 'personal' });
  await assert.rejects(api(app, 'POST', '/api/knowledge-tags', { ...space, action: 'metrics' }),
    /Unknown knowledge tag operation/);
  assert.deepEqual(calls.map(({ path }) => path), ['/v1/knowledge-tags/resolve', '/v1/knowledge-tags/metrics',
    '/v1/knowledge-tags/create']);
  assert.deepEqual(calls[0].body, { personal_space_id: 'personal-space', personal_project_id: 'p1',
    query: '户外', limit: 4 });
  assert.deepEqual(calls[1].body, { personal_space_id: 'personal-space', personal_project_id: null,
    include_all_projects: true, days: 7 });
  assert.equal(calls[2].body.operation_actor, 'human');
  assert.equal(calls[2].body.namespace, 'personal');

  const parity = agentInterfaceCatalog().uiMutationParity.find(({ route }) => route === 'POST /api/knowledge-tags');
  assert.deepEqual(parity, { route: 'POST /api/knowledge-tags', access: 'agent', toolName: 'change_knowledge_tags' });
});
