import assert from 'node:assert/strict';
import test from 'node:test';
import { listAgentTools, callAgentTool } from '../src/agent-tools.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';
import { attentionInput, attentionRecord, listAgentAttention, getAgentAttention, changeAgentAttention } from '../src/graphiti/agent-attention.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { handleAgentAttentionRequest } from '../src/http/agent-attention-api-router.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { successToolResult } from '../src/mcp/tool-result.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

test('attention requires an explicit actionable request and never exposes human response as an Agent tool', async () => {
  const definitions = new Map(listAgentTools().map(tool => [tool.name, tool]));
  const input = { personalSpaceId: 'space', personalProjectId: 'project', agentId: 'agent',
    idempotencyKey: 'request-1', kind: 'question', title: 'Choose a target', detail: 'Two targets are available.', requestedAction: 'Choose A or B.' };
  const schema = jsonSchemaToZod(definitions.get('request_agent_attention').inputSchema);
  assert.equal(schema.safeParse(input).success, true);
  assert.equal(schema.safeParse({ ...input, requestedAction: '' }).success, false);
  assert.equal(schema.safeParse({ ...input, kind: 'running' }).success, false);
  assert.equal(definitions.has('respond_to_agent_attention'), false);
  assert.deepEqual(await callAgentTool({ getAgentAccessPolicy: () => ({ enabled: true }), requestAgentAttention: value => value }, 'request_agent_attention', input), input);
  const reply = agentInterfaceCatalog().uiMutationParity.find(item => item.route === 'POST /api/agent-attention/respond');
  assert.equal(reply.access, 'local_user_only');
});

test('an open attention request carries explicit native choices without a response authority', async () => {
  const definition = listAgentTools().find(tool => tool.name === 'request_agent_attention');
  const input = { personalSpaceId: 's', personalProjectId: 'p', agentId: 'a',
    idempotencyKey: 'request-choices', kind: 'question', title: 'Choose a target',
    detail: 'Both targets are accessible.', requestedAction: 'Which target should this task use?', options: ['A', 'B'] };
  assert.equal(jsonSchemaToZod(definition.inputSchema).safeParse(input).success, true);
  const result = await listAgentAttention({ personal: { listAgentAttention: async () => ({
    items: [{ request_id: 'request', personal_space_id: 's', personal_project_id: 'p',
      status: 'open', revision: 2, title: input.title, requested_action: input.requestedAction, options: input.options }],
    total: 1, counts: { a: 1 }
  }) } }, { personalSpaceId: 's', personalProjectId: 'p' });
  assert.deepEqual(result.human_interaction?.options, ['A', 'B']);
  assert.equal(result.human_interaction?.allow_custom_input, true);
  assert.equal(result.human_interaction?.source.revision, 2);
  assert.match(result.human_interaction?.guidance ?? '', /not.*approval|no.*permission/i);
});

test('bounded tool delivery preserves the complete native question ahead of optional records', () => {
  const human_interaction = { presentation: 'host_native_single_choice', source: { id: 'q', revision: 1 },
    question: '完整问题'.repeat(180), options: ['A', 'B'], allow_custom_input: true };
  const result = successToolResult({ records: Array.from({length: 100}, () => ({ note: 'data'.repeat(500) })),
    human_interaction }, { limitBytes: 16 * 1024, preserveHumanInteraction: true });
  assert.deepEqual(result.structuredContent.human_interaction, human_interaction);
  assert.equal(result.structuredContent.truncated, true);
});

test('MCP delivers the complete native question in both channels without a human-response tool', async t => {
  const app = { getAgentAccessPolicy: () => ({enabled:true}), personal: {
    changeAgentAttention: async (_operation, input) => ({...input, request_id:'synthetic-request', status:'open', revision:0})
  } };
  app.requestAgentAttention = input => changeAgentAttention(app, 'create', input);
  const server = createMcpServer(app, {env:{}, registerResources:false});
  const client = new Client({name:'native-question-fixture',version:'1'});
  const [clientTransport,serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const question = '请选择本次使用的目标，不改变任何权限。'.repeat(50);
  const result = await client.callTool({name:'request_agent_attention', arguments:{
    personalSpaceId:'s',personalProjectId:'p',agentId:'a',idempotencyKey:'native-mcp-question',kind:'question',
    title:'Choose a target',detail:'Synthetic choice; no actual action.',requestedAction:question,options:['A','B']
  }});
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.human_interaction.question, question);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal((await client.listTools()).tools.some(tool=>tool.name==='respond_to_agent_attention'), false);
});

test('attention maps scope, revisions and responses without losing complete counts', async () => {
  assert.deepEqual(attentionInput({ personalSpaceId: 'space', expectedRevision: 2, response: 'A' }), { personal_space_id: 'space', expected_revision: 2, response: 'A' });
  assert.deepEqual(attentionRecord({ request_id: 'request', responded_by: 'human', revision: 3 }), { requestId: 'request', respondedBy: 'human', revision: 3 });
  const result = await listAgentAttention({ personal: { listAgentAttention: async scope => {
    assert.equal(scope.personal_space_id, 'space');
    return { items: [{ request_id: 'one' }], total: 201, counts: { agent: 201 } };
  } } }, { personalSpaceId: 'space' });
  assert.equal(result.counts.agent, 201);
  assert.equal(result.items[0].requestId, 'one');
});

test('a linked request is read by exact identity in its space, not from a page of the queue', async () => {
  const calls = [];
  const provider = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic-token',
    fetchImpl: async url => { calls.push(String(url)); return new Response(JSON.stringify({ request_id: 'request/101', personal_space_id: 'space', status: 'resolved', revision: 3 }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  const application = { personal: provider };
  const record = await getAgentAttention(application, { personalSpaceId: 'space', requestId: 'request/101' });
  assert.deepEqual(record, { requestId: 'request/101', personalSpaceId: 'space', status: 'resolved', revision: 3 });
  assert.equal(calls[0], 'http://provider.test/v1/agent-attention/request%2F101?personal_space_id=space');
  await assert.rejects(getAgentAttention(application, { personalSpaceId: 'space', requestId: ' ' }), TypeError);

  let sent;
  const response = { writeHead: status => { sent = { status }; }, setHeader() {}, end: body => { sent.body = JSON.parse(body); } };
  const app = { getAgentAttention: input => ({ seen: input }) };
  const handled = await handleAgentAttentionRequest({ request: { method: 'GET' }, response, app,
    url: new URL('http://fuli.test/api/agent-attention/request?personalSpaceId=space&requestId=request-101') });
  assert.equal(handled, true);
  assert.deepEqual(sent.body, { seen: { personalSpaceId: 'space', requestId: 'request-101' } });
});

test('the open-request list defaults to this console\'s own space for the desktop client', async () => {
  const seen = [];
  const app = { config: { personal: { spaceId: 'own-space' } }, listAgentAttention: input => { seen.push(input); return { items: [] }; } };
  const response = { writeHead() {}, setHeader() {}, end() {} };
  for (const query of ['status=open&limit=20', 'personalSpaceId=other&status=open']) {
    await handleAgentAttentionRequest({ request: { method: 'GET' }, response, app,
      url: new URL(`http://fuli.test/api/agent-attention?${query}`) });
  }
  assert.deepEqual(seen.map(input => [input.personalSpaceId, input.status, input.limit]),
    [['own-space', 'open', 20], ['other', 'open', 100]]);
});
