import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { taskEntryPreferences } from '../src/graphiti/task-entry-preferences.js';

// rec#77: a reply written to the thread must reach the Agent that asked.
// Synthetic space: Milo (Claude Code) asks Nova (Codex) in project "app".
function fixture(t, { answers = false } = {}) {
  const agents = [['milo', 'Milo Reed', ['claude_code']], ['nova', 'Nova Lane', ['codex']]].map(([agentId, name, allowedClients]) =>
    ({ agentId, profile: { name, displayName: name, status: 'active', capabilities: [], allowedClients } }));
  const tasks = {
    milo: { projectAgentId: 'milo', personalProjectId: 'app', sessionId: 'cc-1', sourceApplication: 'claude_code' },
    nova: { projectAgentId: 'nova', personalProjectId: 'app', sessionId: 'cx-1', sourceApplication: 'codex' },
    'milo-other': { projectAgentId: 'milo', personalProjectId: 'other-app', sessionId: 'cc-2', sourceApplication: 'claude_code' }
  };
  const app = { config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => agents,
    taskContextRegistry: { context: async token => tasks[token] },
    personal: { recentAgentSessions: async () => [], listPersonalProjects: async () => [],
      issueAgentDelegation: async () => ({ token: 'synthetic-grant' }),
      verifyAgentDelegation: async () => ({ redeemed: true }), revokeAgentDelegation: async () => {} } };
  let id = 0;
  app.roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), openStore: () => createRoundtableStore(),
    idFactory: () => `id-${++id}`, locateCwd: (client, sessionId) => `/work/${client}/${sessionId}`, clientAvailable: () => true,
    wake: async () => {
      if (answers) return { body: 'Nova 当场回答', sessionId: 'fork-1' };
      throw Object.assign(new Error('offline'), { code: 'client_unavailable' });
    } });
  t.after(() => app.roundtable.close());
  const { roundtable } = app;
  const ask = body => roundtable.messageAgent({ taskContextToken: 'milo', sourceApplication: 'claude_code', to: 'nova', body });
  const reply = (messageId, body) => roundtable.replyMessage({ taskContextToken: 'nova', sourceApplication: 'codex', messageId, body });
  const read = (token = 'milo') => roundtable.readMessages({ taskContextToken: token, sourceApplication: 'claude_code' });
  return { app, roundtable, ask, reply, read };
}

const LONG_REPLY = 'Peta UAT 绑定在重启网关后生效。'.repeat(400);

test('an inbox reply reaches the asker: announced once at task entry, full body once from read_agent_messages', async t => {
  const { roundtable, ask, reply, read } = fixture(t);
  const sent = await ask('Peta UAT 绑定怎么生效？');
  assert.equal(sent.status, 'queued');
  assert.equal((await reply(sent.messageId, LONG_REPLY)).status, 'sent');

  // Only the asker, in the asking project, is told; the replier is not.
  assert.deepEqual(roundtable.agentReplies('nova', 'app'), []);
  assert.deepEqual(roundtable.agentReplies('milo', 'other-app'), []);
  const [notice, ...others] = roundtable.agentReplies('milo', 'app');
  assert.deepEqual(others, []);
  assert.equal(notice.threadId, sent.threadId);
  assert.equal(notice.inReplyTo, sent.messageId);
  assert.equal(notice.from, 'Nova Lane');
  assert.equal(notice.fromClient, 'codex');
  assert.equal([...notice.preview].length, 161);
  assert.ok(notice.preview.endsWith('…'));
  assert.deepEqual(roundtable.agentReplies('milo', 'app'), [], 'the next entry does not announce it again');

  assert.equal((await read('milo-other')).replies, undefined);
  const inbox = await read();
  assert.deepEqual(inbox.replies.map(({ messageId, threadId, from, body }) => ({ messageId, threadId, from, body })),
    [{ messageId: notice.messageId, threadId: sent.threadId, from: 'Nova Lane', body: LONG_REPLY }]);
  assert.match(inbox.repliesGuidance, /once/);
  assert.equal((await read()).replies, undefined, 'a read reply is never returned again');
});

test('read_agent_messages delivers a reply the entry never announced, and pages a full inbox', async t => {
  const { roundtable, ask, reply, read } = fixture(t);
  for (let index = 0; index < 6; index += 1) {
    const sent = await ask(`问题 ${index}`);
    await reply(sent.messageId, `回答 ${index}`);
  }
  const first = await read();
  assert.deepEqual(first.replies.map(({ body }) => body), ['回答 0', '回答 1', '回答 2', '回答 3', '回答 4']);
  assert.match(first.repliesGuidance, /call read_agent_messages again/);
  const second = await read();
  assert.deepEqual(second.replies.map(({ body }) => body), ['回答 5']);
  assert.doesNotMatch(second.repliesGuidance, /again/);
  assert.deepEqual(roundtable.agentReplies('milo', 'app'), []);
});

test('a reply the asker already got back directly is never delivered again', async t => {
  const direct = fixture(t, { answers: true });
  const answered = await direct.ask('现在能回答吗？');
  assert.equal(answered.status, 'answered');
  assert.equal(answered.reply, 'Nova 当场回答');
  assert.deepEqual(direct.roundtable.agentReplies('milo', 'app'), []);
  assert.equal((await direct.read()).replies, undefined);

  const polled = fixture(t);
  const sent = await polled.ask('晚点回答也行');
  await polled.reply(sent.messageId, '晚点的回答');
  const status = await polled.roundtable.messageStatus({ taskContextToken: 'milo', sourceApplication: 'claude_code', messageId: sent.messageId });
  assert.equal(status.reply, '晚点的回答');
  assert.deepEqual(polled.roundtable.agentReplies('milo', 'app'), []);
  assert.equal((await polled.read()).replies, undefined);
});

test('task entry carries the reply notice with its guidance', async t => {
  const { app, ask, reply } = fixture(t);
  const sent = await ask('入口会提示吗？');
  await reply(sent.messageId, '会的');
  const application = { ...app, consoleUrl: 'http://127.0.0.1:2727',
    personal: { ...app.personal,
      resolveProjectAgentContext: async () => ({ status: 'ready', agent: { agent_id: 'milo',
        profile: { name: 'Milo Reed', status: 'active', allowed_clients: ['claude_code'], work_kinds: ['project_context'] } } }),
      getProjectAgentMemory: async () => null, getPersonalProject: async () => null,
      listProjectAgentTasks: async () => [], getProjectAgentCoordinationPolicy: async () => ({}),
      collaborationPreferences: async () => ({ effective_preferences: [] }), listPreferenceConflicts: async () => [] },
    searchKnowledge: async () => ({ facts: [], entities: [] }) };
  const entry = () => taskEntryPreferences(application, { status: 'matched', personalProjectId: 'app' }, {
    projectPath: '/work/app', taskPrompt: '继续', sourceApplication: 'claude_code', agentInvocation: true,
    agentToolName: 'begin_task_context', sessionId: 's', turnId: 't' }, async () => {});
  const first = await entry();
  assert.deepEqual(first.agent_replies.map(({ threadId, from, preview }) => ({ threadId, from, preview })),
    [{ threadId: sent.threadId, from: 'Nova Lane', preview: '会的' }]);
  assert.match(first.agent_replies_guidance, /read_agent_messages/);
  assert.equal((await entry()).agent_replies, undefined);
});

test('read_agent_thread returns whole bodies over MCP and pages with after/limit', async t => {
  const { app, ask, reply } = fixture(t);
  const sent = await ask('Peta UAT 绑定怎么生效？');
  await reply(sent.messageId, LONG_REPLY);
  const server = createMcpServer(app, { sourceApplication: 'claude_code', toolNames: ['read_agent_thread', 'agent_chat'] });
  const client = new Client({ name: 'reply-delivery-test', version: '1.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); });

  const whole = await client.callTool({ name: 'read_agent_thread', arguments: { threadId: sent.threadId } });
  assert.equal(whole.isError, undefined, JSON.stringify(whole));
  assert.equal(whole.structuredContent.truncated, undefined);
  assert.equal(whole.structuredContent.messages[1].body, LONG_REPLY);
  assert.equal(whole.structuredContent.nextAfter, undefined);
  assert.deepEqual(JSON.parse(whole.content[0].text), whole.structuredContent);

  const first = await client.callTool({ name: 'read_agent_thread', arguments: { threadId: sent.threadId, limit: 1 } });
  assert.deepEqual(first.structuredContent.messages.map(({ kind }) => kind), ['ask']);
  const rest = await client.callTool({ name: 'read_agent_thread',
    arguments: { threadId: sent.threadId, after: first.structuredContent.nextAfter } });
  assert.deepEqual(rest.structuredContent.messages.map(({ kind, body }) => [kind, body]), [['reply', LONG_REPLY]]);

  // A thread ID given to agent_chat names the tool that reads it.
  const chat = await client.callTool({ name: 'agent_chat', arguments: { taskContextToken: 'milo', action: 'read', chatId: sent.threadId } });
  assert.equal(chat.isError, true);
  assert.equal(chat.structuredContent.error.code, 'chat_not_found');
  assert.match(chat.structuredContent.error.message, /read_agent_thread/);
});
