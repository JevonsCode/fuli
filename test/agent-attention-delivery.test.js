import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRoundtable } from '../src/agent-roundtable/service.js';
import { createRoundtableStore } from '../src/agent-roundtable/store.js';
import { parseChatResult } from '../src/agent-roundtable/chat-contract.js';
import { respondToAgentAttention } from '../src/graphiti/agent-attention.js';
import { taskEntryPreferences } from '../src/graphiti/task-entry-preferences.js';

// Synthetic space: Milo asked the person in project "garden"; Nova is a peer.
function fixture(t, { roundtable: withRoundtable = true } = {}) {
  const agents = ['milo', 'nova'].map(agentId => ({ agentId, assignments: [{ personalProjectId: 'garden', status: 'active' }],
    profile: { name: agentId, displayName: agentId, status: 'active', capabilities: [] } }));
  const tasks = {
    milo: { projectAgentId: 'milo', personalProjectId: 'garden', sourceApplication: 'codex', sessionId: 'cx-1' },
    nova: { projectAgentId: 'nova', personalProjectId: 'garden', sourceApplication: 'codex', sessionId: 'cx-2' },
    'milo-orchard': { projectAgentId: 'milo', personalProjectId: 'orchard', sourceApplication: 'codex', sessionId: 'cx-3' }
  };
  const decisions = [];
  const app = { config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => agents,
    taskContextRegistry: { context: async token => tasks[token] },
    personal: { recentAgentSessions: async () => [],
      changeAgentAttention: async (operation, input) => {
        decisions.push({ operation, input });
        return { request_id: input.request_id, personal_space_id: 'space', personal_project_id: input.personal_project_id,
          agent_id: 'milo', kind: 'permission', title: '登录 GitHub CLI', requested_action: '请在终端运行 gh auth login',
          status: 'resolved', revision: input.expected_revision + 1, response: input.response, responded_by: 'human',
          created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:05:00Z' };
      } } };
  if (withRoundtable) {
    app.roundtable = createAgentRoundtable({ app, openStore: () => createRoundtableStore(),
      wake: async () => { throw new Error('Delivering a reply must never start a session'); } });
    t.after(() => app.roundtable.close());
  }
  const respond = (input = {}) => respondToAgentAttention(app, { personalSpaceId: 'space', personalProjectId: 'garden',
    requestId: 'request-1', expectedRevision: 0, choice: '我已完成', note: '已在本机登录', ...input });
  const chat = (token, action, data = {}) => app.roundtable.chat({ taskContextToken: token, sourceApplication: 'codex', action, ...data });
  return { app, decisions, respond, chat };
}

async function entryFor(app, agentId, personalProjectId) {
  const application = { ...app, consoleUrl: 'http://127.0.0.1:2727',
    personal: { ...app.personal,
      resolveProjectAgentContext: async () => ({ status: 'ready', agent: { agent_id: agentId,
        profile: { name: agentId, status: 'active', allowed_clients: ['codex'], work_kinds: ['project_context'] } } }),
      getProjectAgentMemory: async () => null, getPersonalProject: async () => null,
      listProjectAgentTasks: async () => [], getProjectAgentCoordinationPolicy: async () => ({}),
      collaborationPreferences: async () => ({ effective_preferences: [] }), listPreferenceConflicts: async () => [] },
    searchKnowledge: async () => ({ facts: [], entities: [] }) };
  return taskEntryPreferences(application, { status: 'matched', personalProjectId }, {
    projectPath: '/work/garden', taskPrompt: '继续', sourceApplication: 'codex', agentInvocation: true,
    agentToolName: 'begin_task_context', sessionId: 's', turnId: 't' }, async () => {});
}

test('a reply records choice and note as one response and reaches the asking Agent once at its next task', async t => {
  const { app, decisions, respond } = fixture(t);
  const result = await respond();
  assert.equal(decisions[0].operation, 'respond');
  assert.equal(decisions[0].input.response, '我已完成\n\n已在本机登录');
  assert.equal(Object.hasOwn(decisions[0].input, 'choice'), false);
  assert.deepEqual(result.delivery, { status: 'inbox', agentId: 'milo' });
  assert.equal(result.status, 'resolved');

  assert.equal((await entryFor(app, 'nova', 'garden')).attention_replies, undefined);
  assert.equal((await entryFor(app, 'milo', 'orchard')).attention_replies, undefined);
  const entry = await entryFor(app, 'milo', 'garden');
  assert.deepEqual(entry.attention_replies.map(({ requestId, revision, kind, choice, note }) => ({ requestId, revision, kind, choice, note })),
    [{ requestId: 'request-1', revision: 1, kind: 'permission', choice: '我已完成', note: '已在本机登录' }]);
  assert.match(entry.attention_replies[0].summary, /^你之前问的「登录 GitHub CLI」：用户回复了「我已完成」/);
  assert.match(entry.attention_replies_guidance, /not a permission grant or task acceptance/);
  assert.equal((await entryFor(app, 'milo', 'garden')).attention_replies, undefined);
});

test('read_agent_messages returns new answers for the current project beside waiting asks', async t => {
  const { app, respond } = fixture(t);
  await respond({ choice: null, note: '换成 B 方案' });
  assert.equal((await app.roundtable.readMessages({ taskContextToken: 'milo-orchard' })).attentionReplies, undefined);
  const inbox = await app.roundtable.readMessages({ taskContextToken: 'milo' });
  assert.deepEqual(inbox.messages, []);
  assert.equal(inbox.attentionReplies[0].choice, null);
  assert.equal(inbox.attentionReplies[0].note, '换成 B 方案');
  assert.match(inbox.attentionRepliesGuidance, /list_agent_attention/);
  assert.equal((await app.roundtable.readMessages({ taskContextToken: 'milo' })).attentionReplies, undefined);
});

test('an agent_chat wait of the asking Agent returns the answer at once and the console reports woken', { timeout: 5000 }, async t => {
  const { respond, chat } = fixture(t);
  const { chatId } = await chat('milo', 'create', { requestId: 'room', kind: 'direct', members: ['local:nova'] });
  const waiting = chat('milo', 'wait', { chatId, timeoutSeconds: 30 });
  await delay(50);
  const result = await respond();
  const page = await waiting;
  assert.deepEqual(result.delivery, { status: 'woken', agentId: 'milo' });
  assert.deepEqual(page.messages, []);
  assert.equal(page.attentionReplies[0].requestId, 'request-1');
  assert.deepEqual(parseChatResult(page).attentionReplies, page.attentionReplies);
});

test('a waiting session in another project is not woken and the reply stays queued', { timeout: 8000 }, async t => {
  const { app, respond, chat } = fixture(t);
  const { chatId } = await chat('milo-orchard', 'create', { requestId: 'room', kind: 'direct', members: ['local:nova'] });
  const controller = new AbortController();
  const waiting = app.roundtable.chat({ taskContextToken: 'milo-orchard', sourceApplication: 'codex', action: 'wait',
    chatId, timeoutSeconds: 30 }, { signal: controller.signal });
  const cancelled = assert.rejects(waiting, /stop/);
  await delay(50);
  assert.equal((await respond()).delivery.status, 'inbox');
  controller.abort(new Error('stop'));
  await cancelled;
  assert.equal((await app.roundtable.readMessages({ taskContextToken: 'milo' })).attentionReplies.length, 1);
});

test('a reply needs a choice or note, and a missing inbox is reported instead of hidden', async t => {
  const { respond, decisions } = fixture(t, { roundtable: false });
  await assert.rejects(respond({ choice: ' ', note: '' }), TypeError);
  assert.equal(decisions.length, 0);
  const result = await respond();
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.delivery, { status: 'unavailable', agentId: 'milo' });
});

test('the console wakes a wait in a separate MCP process through the shared roundtable file', { timeout: 10000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'fuli-attention-process-'));
  const path = join(directory, 'agent-roundtable.sqlite');
  const { app, chat } = fixture(t, { roundtable: false });
  app.roundtable = createAgentRoundtable({ app, openStore: () => createRoundtableStore(path) });
  const { chatId } = await chat('milo', 'create', { requestId: 'room', kind: 'direct', members: ['local:nova'] });
  const code = `import {createRoundtableStore} from './src/agent-roundtable/store.js';
    import {createChatService} from './src/agent-roundtable/chat-service.js';
    import {createAttentionInbox} from './src/agent-roundtable/attention-inbox.js';
    const store=createRoundtableStore(process.argv[1]);
    const chat=createChatService({store:store.chat,transaction:store.transaction,scope:'space',transport:'local'});
    const inbox=createAttentionInbox({store,spaceId:()=>'space'}).forWait('milo','garden');
    const pending=chat({address:'local:milo'},{action:'wait',chatId:process.argv[2],timeoutSeconds:8},{inbox});
    while(!store.chat.waitingAnywhere('space','local:milo')) await new Promise(resolve=>setTimeout(resolve,10));
    process.send('ready'); process.send(await pending); store.close(); process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, path, chatId], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  // Listen for exit at once: the child can finish before the assertions below do.
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); app.roundtable.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await once(child, 'message'))[0], 'ready');
  const page = once(child, 'message');
  const result = await respondToAgentAttention(app, { personalSpaceId: 'space', personalProjectId: 'garden',
    requestId: 'request-1', expectedRevision: 0, choice: '我已完成' });
  assert.equal((await page)[0].attentionReplies[0].choice, '我已完成');
  assert.equal(result.delivery.status, 'woken');
  assert.deepEqual(await exited, [0, null]);
});
