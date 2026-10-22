import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleKnowledgeTagsRequest } from '../src/http/knowledge-tags-api-router.js';
import { knowledgeTagsConsole } from '../src/knowledge-tags/console-port.js';
import { normalizeAgentSessionInput } from '../src/mcp/session-id.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';
import { reachableModules } from '../test-support/module-graph.js';

// Synthetic Provider boundary: the tools must send the Provider contract and
// keep Agent attribution; the vocabulary rules themselves are Provider tests.
const CONFIG = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
  accessToken: 'synthetic-token', principalId: 'synthetic-owner', spaceId: 'personal-space' } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIGEST = 'a'.repeat(64);
const PREVIEW = { change: 'merge', tag: { id: 'tag-a', name: '户外学习', namespace: 'project', status: 'provisional' },
  other: { id: 'tag-b', name: '自然教育', namespace: 'personal', status: 'active' }, links_moved: null,
  blocked: null, digest: DIGEST };

function application() {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, { consoleUrl: 'http://127.0.0.1:4545', fetchImpl: async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({ path: url.pathname, method: options.method ?? 'GET',
      body: options.body ? JSON.parse(options.body) : null });
    const body = url.pathname.endsWith('/governance/preview') ? PREVIEW : { outcome: 'synthetic' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
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
  assert.deepEqual(change.inputSchema.properties.action.enum,
    ['create', 'add_alias', 'attach', 'detach', 'approve', 'merge', 'split', 'retire', 'undo']);
  assert.deepEqual(change.inputSchema.properties.namespace.enum, ['personal', 'project'],
    'shared vocabulary changes are not offered to Agents');
  assert.equal(change.inputSchema.properties.operationActor, undefined);
  assert.equal(change.inputSchema.properties.previewDigest, undefined, 'an Agent can never name a digest to apply');
  assert.match(resolve.description, /Similarity is lexical only; record a synonym with add_alias\./);
  assert.match(change.description, /else namespace personal/);
  assert.match(change.description, /preview only, the person decides at confirmUrl/);
  // Part 2 adds five proposals and intoTagId to the one write tool (+168 B).
  for (const tool of [resolve, change]) {
    assert.ok(Buffer.byteLength(JSON.stringify(tool)) < 1600, `${tool.name} stays compact`);
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

test('an Agent asking for governance gets its own-scope preview and the console link, never the change', async () => {
  const { app, calls } = application();
  const change = definitions().get('change_knowledge_tags');
  const merge = { ...space, personalProjectId: 'nature-class', action: 'merge', tagId: 'tag-a', intoTagId: 'tag-b',
    reason: '同一个意思' };
  assert.equal(jsonSchemaToZod(change.inputSchema).safeParse(merge).success, true);
  // Asking writes nothing, so it is answered even while recording is off.
  await app.updateCapturePolicy({ enabled: false });
  const proposal = await callAgentTool(app, 'change_knowledge_tags', merge);
  assert.equal(proposal.outcome, 'needs_person');
  assert.deepEqual(proposal.preview, PREVIEW);
  assert.equal(proposal.confirmUrl, 'http://127.0.0.1:4545/tags?tag=tag-a&change=merge&into=tag-b');
  assert.match(proposal.guidance, /Nothing changed\. Only the person applies this/);
  await callAgentTool(app, 'change_knowledge_tags', { ...space, action: 'split', tagId: 'tag-a', name: '野外教学',
    alias: '野外课' });
  for (const action of ['approve', 'retire', 'undo']) {
    await callAgentTool(app, 'change_knowledge_tags', { ...space, action, tagId: 'tag-a' });
  }
  assert.deepEqual(calls.map(({ path }) => path), Array(5).fill('/v1/knowledge-tags/governance/preview'));
  assert.deepEqual(calls[0].body, { personal_space_id: 'personal-space', personal_project_id: 'nature-class',
    change: 'merge', tag_id: 'tag-a', into_tag_id: 'tag-b', include_all_projects: false });
  assert.deepEqual(calls[1].body.split, { name: '野外教学', description: null, aliases: ['野外课'], links: [] });
  assert.deepEqual(calls.slice(2).map(({ body }) => body.change), ['approve', 'retire', 'undo']);
  assert.ok(calls.every(({ body }) => body.include_all_projects === false && !('preview_digest' in body)));
  // The Agent's provider client has no route that applies governance.
  assert.throws(() => app.personal.knowledgeTags('governance/apply', {}), /Unknown knowledge tag route/);
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
  for (const action of ['rename', 'remove_alias', 'relate']) {
    await assert.rejects(callAgentTool(app, 'change_knowledge_tags', { ...space, action, tagId: 'a' }),
      /Unknown knowledge tag operation/);
  }
  await assert.rejects(callAgentTool(app, 'resolve_knowledge_tags', { personalSpaceId: 'other', query: 'a' }),
    /active personal space/);
  await assert.rejects(callAgentTool(app, 'change_knowledge_tags', { personalSpaceId: 'other', action: 'merge',
    tagId: 'a', intoTagId: 'b' }), /active personal space/);
  assert.deepEqual(calls, []);
});

function request(method, body, remoteAddress) {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  return Object.assign(stream, { method, headers: { 'content-type': 'application/json' }, socket: { remoteAddress } });
}

async function api(app, method, path, body, { tagsConsole = null, remoteAddress = '127.0.0.1' } = {}) {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  const handled = await handleKnowledgeTagsRequest({ request: request(method, body, remoteAddress), response,
    url: new URL(`http://127.0.0.1${path}`), app, tagsConsole });
  return { handled, ...sent };
}

function fakeConsole() {
  const sent = [];
  return { sent, tagsConsole: { send: async (route, body) => { sent.push({ route, body }); return { ok: route }; } } };
}

test('the local console reads every project and previews governance as the owner', async () => {
  const { app, calls } = application();
  assert.equal((await api(app, 'GET',
    '/api/knowledge-tags?personalSpaceId=personal-space&personalProjectId=p1&q=%E6%88%B7%E5%A4%96&limit=4')).status, 200);
  await api(app, 'GET', '/api/knowledge-tags/metrics?personalSpaceId=personal-space&allProjects=true&days=7');
  await api(app, 'GET', '/api/knowledge-tags/vocabulary?personalSpaceId=personal-space&q=%E6%88%B7&status=review&namespace=project&offset=100&limit=50');
  await api(app, 'GET', '/api/knowledge-tags/detail?personalSpaceId=personal-space&tagId=tag-a');
  const preview = await api(app, 'POST', '/api/knowledge-tags/governance/preview', { ...space, change: 'split',
    tagId: 'tag-a', split: { name: '野外教学', aliases: ['野外课'], links: [{ itemKind: 'entity', itemId: 'item-1' }] } });
  assert.deepEqual(preview.body, PREVIEW);
  await assert.rejects(api(app, 'GET', '/api/knowledge-tags/vocabulary?personalSpaceId=personal-space&status=deleted'),
    /status is not one of/);
  // Splitting a mistaken merge back names the merged tag; the Provider reads what moves from the merge.
  await api(app, 'POST', '/api/knowledge-tags/governance/preview', { ...space, change: 'split', tagId: 'tag-b',
    split: { restoreTagId: 'tag-a', aliases: [] } });
  assert.deepEqual(calls.pop().body.split, { restore_tag_id: 'tag-a', aliases: [] });
  assert.deepEqual(calls.map(({ path }) => path), ['/v1/knowledge-tags/resolve', '/v1/knowledge-tags/metrics',
    '/v1/knowledge-tags/vocabulary', '/v1/knowledge-tags/detail', '/v1/knowledge-tags/governance/preview']);
  assert.deepEqual(calls[0].body, { personal_space_id: 'personal-space', personal_project_id: 'p1',
    query: '户外', limit: 4 });
  assert.deepEqual(calls[1].body, { personal_space_id: 'personal-space', personal_project_id: null,
    include_all_projects: true, days: 7 });
  assert.deepEqual(calls[2].body, { personal_space_id: 'personal-space', personal_project_id: null,
    include_all_projects: true, query: '户', namespace: 'project', status: 'review', limit: 50, offset: 100 });
  assert.deepEqual(calls[3].body, { personal_space_id: 'personal-space', personal_project_id: null,
    tag_id: 'tag-a', include_all_projects: true });
  assert.deepEqual(calls[4].body, { personal_space_id: 'personal-space', personal_project_id: null,
    change: 'split', tag_id: 'tag-a', include_all_projects: true, split: { name: '野外教学', description: null,
      aliases: ['野外课'], links: [{ item_kind: 'entity', item_id: 'item-1' }] } });
});

test('the person changes and governs tags only on this computer, on the human-review channel', async () => {
  const { app, calls } = application();
  const { sent, tagsConsole } = fakeConsole();
  await api(app, 'POST', '/api/knowledge-tags', { ...space, action: 'create', name: '户外学习', reason: 'mine',
    namespace: 'personal', operationActor: 'agent' }, { tagsConsole });
  const governed = await api(app, 'POST', '/api/knowledge-tags/governance', { ...space, change: 'merge', tagId: 'tag-a',
    intoTagId: 'tag-b', reason: '误建的近义标签', previewDigest: DIGEST }, { tagsConsole });
  assert.equal(governed.status, 200);
  await api(app, 'POST', '/api/knowledge-tags/governance', { ...space, change: 'relate', tagId: 'tag-a',
    targetTagId: 'tag-c', relation: 'parent', reason: '上位概念', previewDigest: DIGEST }, { tagsConsole });
  assert.deepEqual(sent.map(({ route }) => route), ['create', 'governance/apply', 'governance/apply']);
  assert.equal(sent[0].body.operation_actor, 'human', 'the console always speaks for the person');
  assert.deepEqual(sent[1].body, { personal_space_id: 'personal-space', personal_project_id: null, change: 'merge',
    tag_id: 'tag-a', into_tag_id: 'tag-b', include_all_projects: true, reason: '误建的近义标签',
    preview_digest: DIGEST });
  assert.equal(sent[2].body.target_tag_id, 'tag-c');
  await assert.rejects(api(app, 'POST', '/api/knowledge-tags', { ...space, action: 'metrics' }, { tagsConsole }),
    /Unknown knowledge tag operation/);
  await assert.rejects(api(app, 'POST', '/api/knowledge-tags/governance', { ...space, change: 'merge', tagId: 'a',
    reason: 'x', previewDigest: 'not-a-digest' }, { tagsConsole }), /previewDigest/);
  await assert.rejects(api(app, 'POST', '/api/knowledge-tags/governance', { ...space, change: 'delete', tagId: 'a',
    reason: 'x', previewDigest: DIGEST }, { tagsConsole }), /tag governance change/);

  const remote = await api(app, 'POST', '/api/knowledge-tags/governance', { ...space, change: 'approve',
    tagId: 'tag-a', reason: 'x', previewDigest: DIGEST }, { tagsConsole, remoteAddress: '192.168.1.20' });
  assert.deepEqual([remote.status, remote.body.code], [403, 'local_user_only']);
  const remoteCreate = await api(app, 'POST', '/api/knowledge-tags', { ...space, action: 'create', name: 'x',
    reason: 'y', namespace: 'personal' }, { tagsConsole, remoteAddress: '192.168.1.20' });
  assert.equal(remoteCreate.status, 403);
  const uninstalled = await api(app, 'POST', '/api/knowledge-tags/governance', { ...space, change: 'approve',
    tagId: 'tag-a', reason: 'x', previewDigest: DIGEST });
  assert.equal(uninstalled.status, 503);
  assert.equal(sent.length, 3);
  assert.deepEqual(calls, [], 'no change went out on the Agent access token');

  const catalog = agentInterfaceCatalog().uiMutationParity;
  assert.deepEqual(catalog.find(({ route }) => route === 'POST /api/knowledge-tags'),
    { route: 'POST /api/knowledge-tags', access: 'agent', toolName: 'change_knowledge_tags' });
  assert.equal(catalog.find(({ route }) => route === 'POST /api/knowledge-tags/governance').access, 'local_user_only');
  // No MCP or Agent tool module reaches the port, the router or the channel that posts it.
  const writing = ['src/knowledge-tags/console-port.js', 'src/http/knowledge-tags-api-router.js',
    'src/graphiti/human-review-channel.js'].map(path => join(ROOT, path));
  for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachableModules(join(ROOT, entry));
    assert.deepEqual(writing.filter(path => modules.has(path)), [], entry);
  }
});

test('the console port sends the human-review token and reports the Provider refusal', async () => {
  const asked = [];
  const port = knowledgeTagsConsole('unused', { send: async (path, body, options) => {
    asked.push({ path, options });
    return path.endsWith('/apply')
      ? { ok: false, status: 409, payload: { detail: { code: 'preview_stale', message: 'The vocabulary changed' } } }
      : { ok: true, status: 200, payload: { outcome: 'created' } };
  } });
  assert.deepEqual(await port.send('create', {}), { outcome: 'created' });
  await assert.rejects(port.send('governance/apply', {}), (error) => error.status === 409
    && error.code === 'preview_stale' && /vocabulary changed/.test(error.message));
  assert.deepEqual(asked, [
    { path: '/v1/knowledge-tags/create', options: { review: true } },
    { path: '/v1/knowledge-tags/governance/apply', options: { review: true } }]);
});
