import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentRoundtable } from '../src/agent-roundtable/service.js';
import { createRoundtableStore } from '../src/agent-roundtable/store.js';
import { parseFinalAnswer, sessionWorkingDirectory, wakeArguments } from '../src/agent-roundtable/wake.js';

const agent = (agentId, name, allowedClients = ['claude_code', 'codex']) => ({ agentId,
  profile: { name, displayName: name, status: 'active', responsibility: `${name} 的职责`, capabilities: [], allowedClients } });

function fixture({ wake, sessions = {} } = {}) {
  const agents = [agent('lead-1', 'Milo Reed'), agent('reviewer-1', 'Nova Lane', ['codex'])];
  const tasks = {
    'token-milo': { token: 'token-milo', projectAgentId: 'lead-1', personalProjectId: 'app', sessionId: 'cc-1', sourceApplication: 'claude_code' },
    'token-nova': { token: 'token-nova', projectAgentId: 'reviewer-1', personalProjectId: 'app', sessionId: 'cx-9', sourceApplication: 'codex' }
  };
  const woken = [];
  const app = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => agents,
    taskContextRegistry: { context: async (token) => tasks[token] },
    personal: { recentAgentSessions: async ({ agentId }) => sessions[agentId] ?? [] }
  };
  let id = 0;
  const roundtable = createAgentRoundtable({ app, openStore: () => createRoundtableStore(), idFactory: () => `id-${++id}`,
    locateCwd: (client, sessionId) => `/work/${client}/${sessionId}`, clientAvailable: () => true,
    wake: async (input) => { woken.push(input); return wake ? wake(input) : { body: 'Nova 的回答', sessionId: 'fork-1' }; } });
  return { roundtable, woken };
}

test('an Agent asks another Agent, which answers from its latest conversation', async () => {
  const { roundtable, woken } = fixture({ sessions: { 'reviewer-1': [
    { source_application: 'codex', session_id: 'cx-9', personal_project_id: 'app', last_active: '2026-10-10T00:00:00Z' }] } });
  const result = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '登录重构评审过了吗？' });
  assert.equal(result.status, 'answered');
  assert.equal(result.reply, 'Nova 的回答');
  assert.equal(result.via, 'codex:resume');
  assert.equal(woken[0].client, 'codex');
  assert.equal(woken[0].sessionId, 'cx-9');
  assert.equal(woken[0].cwd, '/work/codex/cx-9');
  assert.match(woken[0].prompt, /^@\{reviewer-1\} \[FULI 圆桌 · id-1\]/);
  assert.match(woken[0].prompt, /Milo Reed（Claude Code）发来消息/);
  const thread = roundtable.thread({ threadId: result.threadId });
  assert.deepEqual(thread.messages.map(({ kind, status, from, to }) => [kind, status, from.name, to.name]), [
    ['ask', 'answered', 'Milo Reed', 'Nova Lane'], ['reply', 'sent', 'Nova Lane', 'Milo Reed']]);
  const [summary] = roundtable.threads().threads;
  assert.equal(summary.subject, '登录重构评审过了吗？');
  assert.deepEqual(summary.participants.map((person) => person.name), ['Milo Reed', 'Nova Lane']);
  assert.equal(summary.waiting, false);
});

test('a message that cannot be delivered waits in the inbox until the Agent replies', async () => {
  const { roundtable } = fixture({ wake: async () => { throw Object.assign(new Error('offline'), { code: 'client_unavailable' }); } });
  const sent = await roundtable.messageAgent({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'reviewer-1', body: '请看一下 PR' });
  assert.equal(sent.status, 'queued');
  assert.equal(sent.reason, 'client_unavailable');
  const inbox = await roundtable.readMessages({ taskContextToken: 'token-nova', sourceApplication: 'codex' });
  assert.deepEqual(inbox.messages.map(({ from, body }) => [from, body]), [['Milo Reed', '请看一下 PR']]);
  assert.deepEqual(roundtable.pending('reviewer-1').map(({ messageId }) => messageId), [sent.messageId]);
  await roundtable.replyMessage({ taskContextToken: 'token-nova', sourceApplication: 'codex', messageId: sent.messageId, body: '已看，可以合并' });
  assert.deepEqual(roundtable.pending('reviewer-1'), []);
  await assert.rejects(roundtable.replyMessage({ taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    messageId: sent.messageId, body: 'not mine' }), /No such message/);
  assert.equal(roundtable.thread({ threadId: sent.threadId }).messages[1].body, '已看，可以合并');
});

test('a fresh run is used when the recipient has no resumable conversation', async () => {
  const { roundtable, woken } = fixture();
  const result = await roundtable.messageAgent({ taskContextToken: 'token-nova', sourceApplication: 'codex',
    to: 'Milo Reed', body: 'hello', projectPath: '/work/app' });
  assert.equal(result.via, 'claude_code:new');
  assert.deepEqual([woken[0].client, woken[0].sessionId, woken[0].cwd], ['claude_code', null, '/work/app']);
});

test('names must be unambiguous and threads have a message limit', async () => {
  const { roundtable } = fixture();
  await assert.rejects(roundtable.messageAgent({ to: 'Nobody', body: 'x', sourceApplication: 'codex' }), /No active Agent/);
  const first = await roundtable.messageAgent({ to: 'Milo Reed', body: 'start', sourceApplication: 'codex', wait: false });
  assert.equal(first.status, 'queued');
  for (let index = 1; index < 24; index += 1) {
    await roundtable.messageAgent({ to: 'Milo Reed', body: `more ${index}`, threadId: first.threadId, sourceApplication: 'codex', wait: false });
  }
  await assert.rejects(roundtable.messageAgent({ to: 'Milo Reed', body: 'too many', threadId: first.threadId,
    sourceApplication: 'codex', wait: false }), /message limit/);
});

test('wake commands resume read-only without changing the original conversation', () => {
  assert.deepEqual(wakeArguments('claude_code', { sessionId: 'cc-session-1' }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--resume', 'cc-session-1', '--fork-session']);
  assert.deepEqual(wakeArguments('codex', { sessionId: 'cx-session-1' }),
    ['exec', 'resume', '--json', '--ephemeral', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', 'cx-session-1', '-']);
  assert.deepEqual(wakeArguments('codex', { cwd: '/work/app' }),
    ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', '/work/app', '-']);
  assert.throws(() => wakeArguments('codex', { sessionId: '--last; rm' }), /Invalid client session id/);
});

test('final answers are read from each client event stream', () => {
  assert.deepEqual(parseFinalAnswer('claude_code', { code: 0, stdout: [
    JSON.stringify({ type: 'system', session_id: 'fork-1' }), JSON.stringify({ type: 'result', result: ' 好的 ' })].join('\n') }),
  { body: '好的', sessionId: 'fork-1' });
  assert.deepEqual(parseFinalAnswer('codex', { code: 0, stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: 'cx-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    JSON.stringify({ type: 'turn.completed' })].join('\n') }), { body: 'done', sessionId: 'cx-1' });
  assert.throws(() => parseFinalAnswer('codex', { code: 0, stdout: JSON.stringify({ type: 'turn.failed' }) }), /did not return an answer/);
});

test('a conversation resumes from the directory its client recorded', () => {
  const home = mkdtempSync(join(tmpdir(), 'fuli-roundtable-home-'));
  mkdirSync(join(home, '.claude', 'projects', 'T--work-app'), { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', 'T--work-app', 'cc-session-1.jsonl'),
    `${JSON.stringify({ type: 'queue-operation' })}\n${JSON.stringify({ type: 'user', cwd: 'T:\\work\\app' })}\n`);
  mkdirSync(join(home, '.codex', 'sessions', '2026', '10', '10'), { recursive: true });
  writeFileSync(join(home, '.codex', 'sessions', '2026', '10', '10', 'rollout-2026-10-10T00-00-00-cx-session-1.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/app' } })}\n`);
  assert.equal(sessionWorkingDirectory('claude_code', 'cc-session-1', { home, env: {} }), 'T:\\work\\app');
  assert.equal(sessionWorkingDirectory('codex', 'cx-session-1', { home, env: {} }), '/work/app');
  assert.equal(sessionWorkingDirectory('codex', 'missing-session', { home, env: {} }), null);
});

test('task entry hands the selected Agent the questions waiting for it', async () => {
  const { taskEntryPreferences } = await import('../src/graphiti/task-entry-preferences.js');
  const waiting = [{ messageId: 'm-1', threadId: 't-1', from: 'Milo Reed', body: '请看一下 PR' }];
  const application = {
    config: { personal: { spaceId: 'space' } }, consoleUrl: 'http://127.0.0.1:2727',
    roundtable: { pending: (agentId) => agentId === 'reviewer-1' ? waiting : [] },
    personal: {
      resolveProjectAgentContext: async () => ({ status: 'ready', agent: { agent_id: 'reviewer-1',
        profile: { name: 'Nova Lane', status: 'active', allowed_clients: ['codex'], work_kinds: ['code_review'] } } }),
      getProjectAgentMemory: async () => null, getPersonalProject: async () => null,
      listProjectAgentTasks: async () => [], getProjectAgentCoordinationPolicy: async () => ({}),
      collaborationPreferences: async () => ({ effective_preferences: [] }), listPreferenceConflicts: async () => []
    },
    searchKnowledge: async () => ({ facts: [], entities: [] })
  };
  const result = await taskEntryPreferences(application, { status: 'matched', personalProjectId: 'app' }, {
    projectPath: '/work/app', taskPrompt: '评审一下', sourceApplication: 'codex', agentInvocation: true,
    agentToolName: 'begin_task_context', sessionId: 's', turnId: 't'
  }, async () => {});
  assert.deepEqual(result.agent_messages, waiting);
  assert.match(result.agent_messages_guidance, /reply_agent_message/);
});
