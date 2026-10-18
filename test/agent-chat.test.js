import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRoundtable } from '../src/agent-roundtable/service.js';
import { createRoundtableStore } from '../src/agent-roundtable/store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { listAgentTools } from '../src/agent-tools.js';
import { handleRoundtableApiRequest } from '../src/agent-roundtable/http.js';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fixture(t) {
  const agents = ['alpha', 'beta', 'gamma'].map(agentId => ({ agentId,
    occupation: { role: agentId === 'beta' ? 'reviewer' : 'engineer' },
    assignments: [{ personalProjectId: 'garden', status: 'active' }],
    profile: { name: agentId, status: 'active', capabilities: [agentId === 'beta' ? 'testing' : 'build'] } }));
  const tasks = Object.fromEntries(agents.map(a => [a.agentId, { projectAgentId: a.agentId,
    personalProjectId: 'garden', sourceApplication: 'codex' }]));
  tasks.completed = { ...tasks.alpha, completed: true };
  tasks.sealed = { ...tasks.alpha, roundtableDelegation: { token: 'restricted' } };
  let wakes = 0;
  const app = { config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => agents,
    personal: { recentAgentSessions: async () => [] },
    taskContextRegistry: { context: async (token, client) => {
      if (!tasks[token] || client !== 'codex') throw new Error('Unknown task');
      return tasks[token];
    } } };
  const roundtable = createAgentRoundtable({ app, openStore: () => createRoundtableStore(),
    wake: async () => { wakes++; throw new Error('Chat must never wake'); } });
  app.roundtable = roundtable;
  t.after(() => roundtable.close());
  const chat = (who, action, data = {}) => roundtable.chat({ taskContextToken: who,
    sourceApplication: 'codex', action, ...data });
  return { app, roundtable, chat, agents, wakes: () => wakes };
}

test('direct chat is persistent communication, isolated to its two members and idempotent', async t => {
  const { chat, roundtable, wakes } = fixture(t);
  const input = { requestId: 'create-1', kind: 'direct', members: ['local:beta'] };
  const room = await chat('alpha', 'create', input);
  assert.equal(room.transport, 'local');
  assert.equal(room.kind, 'direct');
  assert.deepEqual(room.members.map(m => m.address).sort(), ['local:alpha', 'local:beta']);
  assert.equal((await chat('alpha', 'create', input)).chatId, room.chatId);
  await assert.rejects(chat('alpha', 'create', { ...input, members: ['local:gamma'] }), /request|different/i);
  const sent = await chat('alpha', 'send', { chatId: room.chatId, requestId: 'send-1', body: 'hello' });
  assert.equal(sent.seq, 1);
  assert.equal((await chat('alpha', 'send', { chatId: room.chatId, requestId: 'send-1', body: 'hello' })).messageId, sent.messageId);
  await assert.rejects(chat('alpha', 'send', { chatId: room.chatId, requestId: 'send-1', body: 'changed' }), /request|different/i);
  const reply = await chat('beta', 'send', { chatId: room.chatId, requestId: 'reply-1', body: 'world' });
  assert.equal(reply.seq, 2);
  const first = await chat('beta', 'read', { chatId: room.chatId, limit: 1 });
  assert.deepEqual(first.messages.map(m => m.body), ['hello']);
  assert.equal(first.hasMore, true);
  assert.deepEqual((await chat('alpha', 'read', { chatId: room.chatId, after: first.nextAfter })).messages.map(m => m.body), ['world']);
  assert.equal((await chat('gamma', 'list')).chats.length, 0);
  await assert.rejects(chat('gamma', 'read', { chatId: room.chatId }), /member|not found/i);
  await assert.rejects(chat('gamma', 'send', { chatId: room.chatId, requestId: 'leak', body: 'no' }), /member|not found/i);
  assert.equal((await roundtable.chatOwner({ action: 'list' })).chats.length, 1);
  assert.equal(wakes(), 0);
});

test('group membership is versioned, only the owner admits members, removal revokes reads and re-add hides old history', async t => {
  const { chat } = fixture(t);
  const room = await chat('alpha', 'create', { requestId: 'g-1', kind: 'group', title: 'Review', members: ['local:beta'] });
  await chat('alpha', 'send', { chatId: room.chatId, requestId: 'old', body: 'before admission' });
  await assert.rejects(chat('beta', 'members', { chatId: room.chatId, expectedRevision: room.revision, add: ['local:gamma'] }), /owner/i);
  const added = await chat('alpha', 'members', { chatId: room.chatId, expectedRevision: room.revision, add: ['local:gamma'] });
  assert.equal(added.revision, room.revision + 1);
  await assert.rejects(chat('alpha', 'members', { chatId: room.chatId, expectedRevision: room.revision, remove: ['local:beta'] }), /revision/i);
  assert.deepEqual((await chat('gamma', 'read', { chatId: room.chatId })).messages, []);
  await chat('gamma', 'send', { chatId: room.chatId, requestId: 'new', body: 'after admission' });
  const left = await chat('beta', 'members', { chatId: room.chatId, expectedRevision: added.revision, remove: ['local:beta'] });
  await assert.rejects(chat('beta', 'read', { chatId: room.chatId }), /member|not found/i);
  const readded = await chat('alpha', 'members', { chatId: room.chatId, expectedRevision: left.revision, add: ['local:beta'] });
  assert.deepEqual((await chat('beta', 'read', { chatId: room.chatId })).messages, []);
  await assert.rejects(chat('alpha', 'members', { chatId: room.chatId, expectedRevision: readded.revision, remove: ['local:alpha'] }), /owner/i);
  const transferred = await chat('alpha', 'members', { chatId: room.chatId, expectedRevision: readded.revision, owner: 'local:gamma' });
  assert.equal(transferred.owner, 'local:gamma');
  await chat('alpha', 'members', { chatId: room.chatId, expectedRevision: transferred.revision, remove: ['local:alpha'] });
  await assert.rejects(chat('alpha', 'read', { chatId: room.chatId }), /member|not found/i);
});

test('separate clients and a restart share one durable chat with atomic create/send and membership CAS', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-chat-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { app } = fixture(t);
  const open = () => createAgentRoundtable({ app, openStore: () => createRoundtableStore(join(directory, 'chat.sqlite')) });
  const clients = [open(), open()];
  t.after(() => clients.forEach(client => client.close()));
  const call = (client, action, data) => client.chat({ taskContextToken: 'alpha', sourceApplication: 'codex', action, ...data });
  const rooms = await Promise.all(clients.map(client => call(client, 'create', { requestId: 'shared-create', kind: 'group', members: ['local:beta'] })));
  assert.equal(rooms[0].chatId, rooms[1].chatId);
  const chatId = rooms[0].chatId;
  const writes = await Promise.all(clients.map(client => call(client, 'send', { chatId, requestId: 'shared-send', body: '  code\n    indented\n' })));
  assert.deepEqual(writes[0], writes[1]);
  const edits = await Promise.allSettled(clients.map(client => call(client, 'members', { chatId, expectedRevision: 1, add: ['local:gamma'] })));
  assert.deepEqual(edits.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  clients.forEach(client => client.close()); clients.length = 0;
  const restarted = open(); clients.push(restarted);
  const history = await call(restarted, 'read', { chatId });
  assert.equal(history.revision, 2);
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].body, '  code\n    indented\n');
});

test('chat validates bounded input, immutable direct members, current identity and active directory entries', async t => {
  const { chat, agents } = fixture(t);
  await assert.rejects(chat('alpha', 'create', { requestId: 'bad', kind: 'direct', members: ['local:beta', 'local:gamma'] }), /two|direct/i);
  await assert.rejects(chat('alpha', 'create', { requestId: 'missing', kind: 'group', members: ['local:absent'] }), /active|unknown/i);
  const room = await chat('alpha', 'create', { requestId: 'ok', kind: 'direct', members: ['local:beta'] });
  await assert.rejects(chat('beta', 'members', { chatId: room.chatId, expectedRevision: 1, remove: ['local:beta'] }), /direct/i);
  await assert.rejects(chat('alpha', 'send', { chatId: room.chatId, requestId: 'large', body: 'x'.repeat(16001) }), /long|16000|body/i);
  await assert.rejects(chat('completed', 'list'), /active|current|completed/i);
  await assert.rejects(chat('sealed', 'list'), /restricted/i);
  agents[0].profile.status = 'retired';
  await assert.rejects(chat('alpha', 'list'), /active/i);
});

test('the advertised MCP chat contract preserves a complete long message on both channels and rejects impersonation', async t => {
  const { app, chat } = fixture(t);
  assert.ok(listAgentTools().some(tool => tool.name === 'agent_chat'));
  const room = await chat('alpha', 'create', { requestId: 'mcp-room', kind: 'direct', members: ['local:beta'] });
  const body = '完整中文消息'.repeat(1800);
  await chat('alpha', 'send', { chatId: room.chatId, requestId: 'mcp-message', body });
  const server = createMcpServer(app, { sourceApplication: 'codex', toolNames: ['agent_chat'] });
  const client = new Client({ name: 'chat-protocol-test', version: '1.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'agent_chat', arguments: { taskContextToken: 'beta', action: 'read', chatId: room.chatId } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.messages[0].body, body);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const forged = await client.callTool({ name: 'agent_chat', arguments: { taskContextToken: 'gamma', action: 'send',
    chatId: room.chatId, requestId: 'forged', body: 'no' } });
  assert.equal(forged.isError, true);
  assert.equal(forged.structuredContent.error.code, 'chat_not_found');
});

test('the console chat routes expose read-only owner history and dispatch writes with the task identity', async t => {
  const { roundtable, chat } = fixture(t);
  const room = await chat('alpha', 'create', { requestId: 'http-room', kind: 'direct', members: ['local:beta'] });
  const call = async (method, path, body = null) => {
    let status, value;
    const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); request.method = method;
    const response = { writeHead: code => { status = code; }, end: text => { value = JSON.parse(text); } };
    const handled = await handleRoundtableApiRequest({ request, response, url: new URL(path, 'http://localhost'), roundtable });
    return { handled, status, value };
  };
  assert.equal((await call('GET', '/api/roundtable/chats')).value.chats[0].chatId, room.chatId);
  const sent = await call('POST', '/api/roundtable/chats', { taskContextToken: 'beta', sourceApplication: 'codex',
    action: 'send', chatId: room.chatId, requestId: 'http-1', body: 'http message' });
  assert.equal(sent.status, 200);
  const read = await call('GET', `/api/roundtable/chats/${encodeURIComponent(room.chatId)}`);
  assert.equal(read.value.messages[0].body, 'http message');
  const denied = await call('POST', '/api/roundtable/chats', { taskContextToken: 'gamma', sourceApplication: 'codex',
    action: 'send', chatId: room.chatId, requestId: 'http-2', body: 'forged' });
  assert.equal(denied.status, 404);
});

test('room list cursors and bounded message pages can retrieve the complete history', async t => {
  const { chat } = fixture(t);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await chat('alpha', 'create', { requestId: `page-${i}`, kind: 'group', members: ['local:beta'] })).chatId);
  const first = await chat('alpha', 'list', { limit: 2, transport: 'local' });
  assert.equal(first.hasMore, true);
  const next = await chat('alpha', 'list', { limit: 2, transport: 'local', afterChat: first.nextChat });
  assert.equal(next.hasMore, false);
  assert.deepEqual([...first.chats, ...next.chats].map(r => r.chatId).sort(), ids.sort());
  const chatId = ids[0], body = '中文'.repeat(8000);
  for (let i = 0; i < 4; i++) await chat('alpha', 'send', { chatId, requestId: `large-${i}`, body });
  let page = await chat('beta', 'read', { chatId, limit: 100 });
  assert.ok(page.messages.length < 4 && page.hasMore);
  const messages = [...page.messages];
  while (page.hasMore) { page = await chat('beta', 'read', { chatId, after: page.nextAfter }); messages.push(...page.messages); }
  assert.deepEqual(messages.map(m => m.seq), [1,2,3,4]);
  assert.ok(messages.every(m => m.body === body));
});

test('Agent discovery includes occupation, projects and capabilities without selecting only the project lead', async t => {
  const { roundtable } = fixture(t);
  const result = await roundtable.findAgents({ occupation: 'reviewer', capability: 'testing' });
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].agentId, 'beta');
  assert.equal(result.agents[0].occupation, 'reviewer');
  assert.deepEqual(result.agents[0].capabilities, ['testing']);
  assert.deepEqual(result.agents[0].projects, ['garden']);
  assert.equal(result.agents[0].address, 'local:beta');
});
