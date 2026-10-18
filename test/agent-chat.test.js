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
import { runWithAgentRequestContext, sealedWorkerRequestContext } from '../src/app/agent-request-context.js';

function fixture(t) {
  const agents = ['alpha', 'beta', 'gamma'].map(agentId => ({ agentId,
    occupation: { role: agentId === 'beta' ? 'reviewer' : 'engineer' },
    assignments: [{ personalProjectId: 'garden', status: 'active' }],
    profile: { name: agentId, status: 'active', capabilities: [agentId === 'beta' ? 'testing' : 'build'] } }));
  const tasks = Object.fromEntries(agents.map(a => [a.agentId, { projectAgentId: a.agentId,
    personalProjectId: 'garden', sourceApplication: 'codex' }]));
  tasks.completed = { ...tasks.alpha, completed: true };
  tasks.sealed = { ...tasks.alpha, agentMemoryScope: 'task_only' };
  tasks.worker = { ...tasks.alpha, agentMemoryScope: 'reviewed_agent', turnId: 'worker-run:bounded' };
  tasks.adopted = { ...tasks.alpha, agentMemoryScope: 'reviewed_agent', turnId: 'ordinary-task' };
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
  const { app } = fixture(t);
  const open = () => createAgentRoundtable({ app, openStore: () => createRoundtableStore(join(directory, 'chat.sqlite')) });
  const clients = [open(), open()];
  // Close before removing: Windows cannot delete a SQLite file that is still open.
  t.after(async () => { clients.forEach(client => client.close()); await rm(directory, { recursive: true, force: true }); });
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
  await assert.rejects(chat('worker', 'list'), /restricted/i);
  await assert.rejects(runWithAgentRequestContext(sealedWorkerRequestContext({}), () => chat('alpha', 'list')), /restricted/i);
  agents[0].profile.status = 'retired';
  await assert.rejects(chat('alpha', 'list'), /active/i);
});

test('an ordinary recruited lead can chat after adopting its reviewed Agent memory', async t => {
  const { chat } = fixture(t);
  const room = await chat('adopted', 'create', { requestId: 'adopted-chat', kind: 'direct', members: ['local:beta'] });
  assert.deepEqual(room.members.map(m => m.address).sort(), ['local:alpha', 'local:beta']);
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

test('wait exchanges ten rounds from storage notifications and returns ordered offline backlog', { timeout: 5000 }, async t => {
  const { chat } = fixture(t);
  const { chatId } = await chat('alpha', 'create', { requestId: 'wait-room', kind: 'direct', members: ['local:beta'] });
  let after = 0;
  for (let round = 0; round < 10; round++) {
    for (const [from, to] of [['alpha', 'beta'], ['beta', 'alpha']]) {
      const waiting = chat(to, 'wait', { chatId, after });
      await chat(from, 'send', { chatId, requestId: `${round}-${from}`, body: `${round}:${from}` });
      const result = await waiting;
      assert.deepEqual(result.messages.map(m => m.body), [`${round}:${from}`]);
      after = result.nextAfter;
    }
  }
  for (let i = 0; i < 3; i++) await chat('alpha', 'send', { chatId, requestId: `offline-${i}`, body: `offline-${i}` });
  const backlog = await chat('beta', 'wait', { chatId, after, limit: 2 });
  assert.deepEqual(backlog.messages.map(m => m.seq), [21, 22]);
  assert.equal(backlog.hasMore, true);
  assert.deepEqual((await chat('beta', 'wait', { chatId, after: backlog.nextAfter })).messages.map(m => m.seq), [23]);
});

test('wait validates its deadline and rechecks membership after a pending read', async t => {
  const { chat } = fixture(t);
  const { chatId } = await chat('alpha', 'create', { requestId: 'wait-group', kind: 'group', members: ['local:beta'] });
  await assert.rejects(chat('beta', 'wait', { chatId, timeoutSeconds: 301 }), /300|timeout/i);
  await assert.rejects(chat('beta', 'wait', { chatId, timeoutSeconds: 0 }), /timeout|1/i);
  const waiting = chat('beta', 'wait', { chatId });
  const denied = assert.rejects(waiting, /member|not found/i);
  await chat('alpha', 'members', { chatId, expectedRevision: 1, remove: ['local:beta'] });
  await denied;
});

test('wait returns an empty page and unchanged cursor on timeout', { timeout: 3000 }, async t => {
  const { chat } = fixture(t);
  const { chatId } = await chat('alpha', 'create', { requestId: 'wait-timeout', kind: 'direct', members: ['local:beta'] });
  const result = await chat('beta', 'wait', { chatId, timeoutSeconds: 1 });
  assert.deepEqual(result.messages, []);
  assert.equal(result.nextAfter, 0);
});

test('a separate MCP process wait observes a committed message without polling', { timeout: 5000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { app } = fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'fuli-chat-process-'));
  const path = join(directory, 'chat.sqlite');
  const roundtable = createAgentRoundtable({ app, openStore: () => createRoundtableStore(path) });
  const room = await roundtable.chat({ taskContextToken: 'alpha', sourceApplication: 'codex', action: 'create',
    requestId: 'process-chat', kind: 'direct', members: ['local:beta'] });
  const code = `import {createRoundtableStore} from './src/agent-roundtable/store.js';
    import {createChatService} from './src/agent-roundtable/chat-service.js';
    const store=createRoundtableStore(process.argv[1]);
    const chat=createChatService({store:store.chat,transaction:store.transaction,scope:'space',transport:'local'});
    const pending=chat({address:'local:beta'},{action:'wait',chatId:process.argv[2],timeoutSeconds:3});
    process.send('ready'); process.send(await pending); store.close(); process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module','-e',code,path,room.chatId], { stdio: ['ignore','ignore','pipe','ipc'] });
  t.after(async () => { child.kill(); roundtable.close(); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(await once(child, 'message'), ['ready', undefined]);
  const result = once(child, 'message');
  await roundtable.chat({ taskContextToken: 'alpha', sourceApplication: 'codex', action: 'send',
    chatId: room.chatId, requestId: 'process-send', body: 'committed cross process' });
  assert.equal((await result)[0].messages[0].body, 'committed cross process');
  await once(child, 'exit');
});

test('cancelled waits release their storage subscriptions', async t => {
  const { roundtable, chat } = fixture(t);
  const { chatId } = await chat('alpha', 'create', { requestId: 'abort-chat', kind: 'direct', members: ['local:beta'] });
  const controller = new AbortController();
  const waiting = roundtable.chat({ taskContextToken: 'beta', sourceApplication: 'codex', action: 'wait', chatId }, { signal: controller.signal });
  const cancelled = assert.rejects(waiting, /cancelled/);
  controller.abort(new Error('cancelled'));
  await cancelled;
});

test('tool cancellation uses the host request signal and leaves messages unread', async t => {
  const { callRoundtableTool } = await import('../src/agent-roundtable/tools.js');
  const { chat, roundtable } = fixture(t);
  const { chatId } = await chat('alpha','create',{ requestId:'host-abort',kind:'direct',members:['local:beta'] });
  const controller = new AbortController();
  const waiting = runWithAgentRequestContext({signal:controller.signal},()=>callRoundtableTool(roundtable,'agent_chat',{
    action:'wait',chatId,taskContextToken:'beta',sourceApplication:'codex',timeoutSeconds:1
  }));
  const denied = assert.rejects(waiting,/host cancelled/);
  controller.abort(new Error('host cancelled'));
  await denied;
});

test('abort while authorization is pending never advances the durable read cursor', async t => {
  const { createChatService } = await import('../src/agent-roundtable/chat-service.js');
  const store = createRoundtableStore(); t.after(()=>store.close());
  const directory = async()=>['alpha','beta'].map(agentId=>({address:`local:${agentId}`,agentId,name:agentId}));
  const chat = createChatService({store:store.chat,transaction:store.transaction,scope:'space',transport:'local',directory});
  const actor={address:'local:alpha'}, receiver={address:'local:beta'};
  const {chatId}=await chat(actor,{action:'create',requestId:'pending-auth',kind:'direct',members:['local:beta']});
  const paused=Promise.withResolvers(), entered=Promise.withResolvers(); let calls=0;
  const controller=new AbortController();
  const waiting=chat(receiver,{action:'wait',chatId},{signal:controller.signal,authorize:async()=>{
    if(++calls===2){entered.resolve();await paused.promise;}
  }});
  const denied=assert.rejects(waiting,/cancelled/);
  await entered.promise;
  await chat(actor,{action:'send',chatId,requestId:'during-auth',body:'must remain unread'});
  controller.abort(new Error('cancelled')); await denied;
  paused.resolve();
  const {scheduler}=await import('node:timers/promises'); await scheduler.yield();
  assert.equal(store.chat.readCursor(chatId,'local:beta'),0);
});
