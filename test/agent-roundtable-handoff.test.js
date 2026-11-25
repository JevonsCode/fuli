import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { HANDOFF_MAX_BYTES, handoffFor, handoffText } from '../packages/roundtable/src/roundtable/recent-handoff.js';
import { callRoundtableTool } from '../src/agent-roundtable/tools.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { roundtableHandoff } from '../src/graphiti/roundtable-handoff.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const at = hoursAgo => new Date(NOW - hoursAgo * 3_600_000).toISOString();

const agent = (agentId, name, allowedClients = ['claude_code', 'codex']) => ({ agentId,
  employeeNumber: agentId === 'lead-1' ? '000001' : '000002', assignments: [],
  profile: { name, displayName: name, status: 'active', responsibility: `${name} 的职责`, capabilities: [], allowedClients } });

// One task as view_project_agent_task and list_project_agent_tasks return it.
const task = (taskId, title, status, hoursAgo, { personalProjectId = 'app', leadAgentId = 'lead-1',
  participants = [{ agentId: leadAgentId, role: 'lead', status: 'active' }], resultSummary = null,
  verifiedArtifactRevision = null, qualityGate = null, runId = null, sourceApplication = 'codex',
  completedAt = ['completed', 'failed', 'cancelled', 'skipped'].includes(status) ? at(hoursAgo) : null } = {}) => ({
  taskId, personalProjectId, title, status, leadAgentId, participants, resultSummary, failureReason: null,
  qualityGate, verifiedArtifactRevision, runId, sourceApplication, createdAt: at(hoursAgo + 1),
  updatedAt: at(hoursAgo), completedAt });

function fixture({ tasks = [], sessions = {}, storePath = null, wake = null, peer = null,
  taskRecordsUnavailable = false, viewUnavailable = false, coordinationTaskId = {} } = {}) {
  const agents = [agent('lead-1', 'Milo Reed'), agent('reviewer-1', 'Nova Lane', ['codex'])];
  const contexts = {
    'token-milo': { token: 'token-milo', projectAgentId: 'lead-1', personalProjectId: 'app', sessionId: 'cc-1',
      sourceApplication: 'claude_code', coordinationTaskId: coordinationTaskId['token-milo'] ?? null },
    'token-nova': { token: 'token-nova', projectAgentId: 'reviewer-1', personalProjectId: 'app', sessionId: 'cx-9',
      sourceApplication: 'codex', coordinationTaskId: coordinationTaskId['token-nova'] ?? null },
    'token-nova-other-session': { token: 'token-nova-other-session', projectAgentId: 'reviewer-1', personalProjectId: 'app',
      sessionId: 'cx-other', sourceApplication: 'codex', coordinationTaskId: null },
    'token-nova-other-project': { token: 'token-nova-other-project', projectAgentId: 'reviewer-1', personalProjectId: 'other-app',
      sessionId: 'cx-7', sourceApplication: 'codex', coordinationTaskId: null }
  };
  const woken = [];
  const sentToPeer = [];
  const app = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgents: async () => agents,
    // Like the Provider, a token resolves only for the client that began it.
    taskContextRegistry: { context: async (token, client) => {
      if (contexts[token] && client && client !== contexts[token].sourceApplication) throw new Error('Task context not found for this client');
      return contexts[token];
    } },
    standingAssignments: createStandingAssignments(),
    listProjectAgentTasks: async ({ personalProjectId, agentId }) => {
      if (taskRecordsUnavailable) throw new Error('task records unavailable');
      return tasks.filter(item => item.personalProjectId === personalProjectId
        && (!agentId || item.leadAgentId === agentId || (item.participants ?? []).some(person => person.agentId === agentId)));
    },
    viewProjectAgentTask: async ({ taskId, personalProjectId }) => {
      if (viewUnavailable) throw new Error('task unavailable');
      const found = tasks.find(item => item.taskId === taskId && item.personalProjectId === personalProjectId);
      if (!found) throw Object.assign(new Error('no such task'), { status: 404 });
      return found;
    },
    personal: {
      recentAgentSessions: async ({ agentId }) => sessions[agentId] ?? [],
      listPersonalProjects: async () => [],
      issueAgentDelegation: async () => ({ token: 'synthetic-grant' }),
      verifyAgentDelegation: async () => ({ redeemed: true }),
      revokeAgentDelegation: async () => {}
    }
  };
  let id = 0;
  if (peer) app.peer = peer;
  const host = createFuliRoundtableHost(app);
  const roundtable = createAgentRoundtable({ host, peer: app.peer, env: {},
    openStore: () => createRoundtableStore(storePath ?? ':memory:'), idFactory: () => `id-${++id}`, now: () => NOW,
    locateCwd: (client, sessionId) => `/work/${client}/${sessionId}`, clientAvailable: () => true, groupAlive: () => false,
    wake: async input => { woken.push(input); return wake ? wake(input) : { body: '收到', sessionId: 'fork-1' }; } });
  return { app, host, roundtable, woken, sentToPeer };
}

// The tools as FULI publishes them, not the service internals.
const call = (roundtable, name, input) => callRoundtableTool(roundtable, name, input);

const installed = () => [
  task('task-installer', 'installer 构建与冒烟测试', 'completed', 2, { resultSummary: '安装包已产出，冒烟通过；还差启动检查',
    verifiedArtifactRevision: 'rev-7', qualityGate: 'passed', runId: 'run-9', sourceApplication: 'codex' }),
  task('task-startup', '启动检查', 'in_progress', 1, { resultSummary: null })
];

test('A’s finished work reaches B through the ordinary inbox, and survives a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-handoff-'));
  const storePath = join(directory, 'roundtable.sqlite');
  try {
    const first = fixture({ tasks: installed(), storePath, coordinationTaskId: { 'token-milo': 'task-installer' } });
    const sent = await call(first.roundtable, 'message_agent', { taskContextToken: 'token-milo', sourceApplication: 'claude_code',
      to: 'Nova Lane', body: '安装器做完了，请你接着做启动检查', wait: false });
    assert.equal(sent.status, 'queued');
    // The recipient is already running here: its ordinary inbox answers at once.
    const live = await call(first.roundtable, 'read_agent_messages', { taskContextToken: 'token-nova', sourceApplication: 'codex' });
    assert.equal(live.messages.length, 1);
    assert.match(live.messages[0].handoff, /task task-installer/);
    await first.roundtable.close();

    // Another process, another task entry: B reads the same ask from its inbox.
    const second = fixture({ tasks: installed(), storePath });
    const inbox = await call(second.roundtable, 'read_agent_messages', { taskContextToken: 'token-nova', sourceApplication: 'codex' });
    assert.equal(inbox.messages.length, 1);
    const message = inbox.messages[0];
    assert.equal(message.body, '安装器做完了，请你接着做启动检查');
    assert.match(message.handoff, /^接手交接：Milo Reed 已完成的工作/);
    assert.match(message.handoff, /已完成 .* installer 构建与冒烟测试/);
    assert.match(message.handoff, /task task-installer/);
    assert.match(message.handoff, /revision rev-7/);
    assert.match(message.handoff, /quality gate passed/);
    assert.match(message.handoff, /run run-9/);
    assert.match(message.handoff, /source codex/);
    assert.match(message.handoff, /结果：安装包已产出，冒烟通过/);
    assert.match(message.handoff, /待接手：启动检查（in_progress，task task-startup）/);
    // The read hint is the real signature, with the task ID it can resolve.
    assert.match(message.handoff, /view_project_agent_task\(personalSpaceId="space", taskId="task-installer"\)/);
    assert.match(message.handoff, /list_project_agent_tasks\(personalSpaceId="space", personalProjectId="app", agentId="lead-1"\)/);
    // The source token never travels, and B's own records are not the handoff.
    assert.equal(message.handoff.includes('token-milo'), false);
    await second.roundtable.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a normal same-project wake carries the same handoff block', async () => {
  const f = fixture({ tasks: installed(), wake: async () => ({ body: '收到，我接着做', sessionId: 'fork-2' }),
    sessions: { 'reviewer-1': [{ source_application: 'codex', session_id: 'cx-9', personal_project_id: 'app',
      last_active: at(1) }] } });
  const result = await call(f.roundtable, 'message_agent', { taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '接着做启动检查', handoffTaskId: 'task-installer' });
  assert.equal(result.status, 'answered');
  const prompt = f.woken[0].prompt;
  assert.match(prompt, /接手交接：Milo Reed 已完成的工作/);
  assert.match(prompt, /task-installer/);
  assert.match(prompt, /revision rev-7/);
  assert.match(prompt, /启动检查/);
  // The sender's ask body stays exactly what the sender wrote, and the raw
  // thread-by-id read is unbound and space-wide: it must not expose the added
  // handoff, which belongs only to the recipient's inbox and wake.
  const thread = await call(f.roundtable, 'read_agent_thread', { threadId: result.threadId });
  assert.equal(thread.messages[0].body, '接着做启动检查');
  assert.equal('handoff' in thread.messages[0], false);
});

test('another session, another project and a paired device cannot read the handoff', async () => {
  // A named session owns the ask: another session of the same FLA does not see it.
  const named = fixture({ tasks: installed() });
  await call(named.roundtable, 'message_agent', { taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '只给这个会话', conversation: 'cx-9', wait: false });
  const otherSession = await call(named.roundtable, 'read_agent_messages', {
    taskContextToken: 'token-nova-other-session', sourceApplication: 'codex' });
  assert.equal(otherSession.messages.length, 0);
  const owner = await call(named.roundtable, 'read_agent_messages', { taskContextToken: 'token-nova', sourceApplication: 'codex' });
  assert.equal(owner.messages.length, 1);
  assert.match(owner.messages[0].handoff, /task-installer/);

  // The same Agent in another project reads nothing of this project's inbox.
  const otherProject = await call(named.roundtable, 'read_agent_messages', {
    taskContextToken: 'token-nova-other-project', sourceApplication: 'codex' });
  assert.equal(otherProject.messages.length, 0);

  // A paired device gets the ordinary remote ask, with no task history attached.
  const remote = fixture({ tasks: installed(), peer: {
    isRemoteAddress: value => value.startsWith('peer:'),
    resolveRemote: async () => ({ address: 'peer:0123456789abcdef:binding', agentId: 'remote-lead', name: '远程', deviceName: 'other' }),
    send: async input => { remote.sentToPeer.push(input); return { status: 'sent' }; },
    waitFor: async () => ({ status: 'sent' }) } });
  const sent = await call(remote.roundtable, 'message_agent', { taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'peer:0123456789abcdef:binding', body: '远程问一句', wait: false });
  assert.equal(sent.status, 'queued');
  assert.equal('handoff' in remote.sentToPeer[0], false);
});

test('ordinary asks are unchanged; unreadable task records leave them working', async () => {
  const plain = fixture({ tasks: [] });
  const sent = await call(plain.roundtable, 'message_agent', { taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '普通消息' });
  assert.equal(sent.status, 'answered');
  assert.equal(plain.woken[0].prompt.includes('接手交接'), false);
  const thread = plain.roundtable.thread({ threadId: sent.threadId });
  assert.equal('handoff' in thread.messages[0], false);
  assert.equal(thread.messages[0].body, '普通消息');

  const unreadable = fixture({ tasks: installed(), taskRecordsUnavailable: true, viewUnavailable: true });
  const stillWorks = await call(unreadable.roundtable, 'message_agent', { taskContextToken: 'token-milo',
    sourceApplication: 'claude_code', to: 'Nova Lane', body: '还看得到吗' });
  assert.equal(stillWorks.status, 'answered');
  assert.equal(unreadable.woken[0].prompt.includes('接手交接'), false);
});

test('another Agent’s task is never a handoff, and expired or future work is ignored', async () => {
  const { app } = fixture({ tasks: [
    task('task-nova', 'Nova 的任务', 'completed', 1, { leadAgentId: 'reviewer-1',
      participants: [{ agentId: 'reviewer-1', role: 'lead', status: 'active' }] }),
    task('task-stale', '三天前的任务', 'completed', 72),
    task('task-future', '还没发生的任务', 'completed', -2),
    task('task-ready', '今天完成的任务', 'completed', 1)
  ] });
  const handoff = await handoffFor({ handoff: input => roundtableHandoff(app, input) },
    { agentId: 'lead-1', agentName: 'Milo Reed', projectId: 'app', asOf: NOW });
  assert.deepEqual(handoff.completed.map(row => row.taskId), ['task-ready']);
});

test('a named open task falls back to the sender’s latest finished task, and a foreign task is never handed off', async () => {
  const { app } = fixture({ tasks: [
    task('task-done', '已完成的任务', 'completed', 2, { resultSummary: '已经做完' }),
    task('task-open', '还没做完的任务', 'in_progress', 1),
    task('task-nova', 'Nova 的任务', 'completed', 1, { leadAgentId: 'reviewer-1',
      participants: [{ agentId: 'reviewer-1', role: 'lead', status: 'active' }] })
  ] });
  const host = { handoff: input => roundtableHandoff(app, input) };
  const fallback = await handoffFor(host, { agentId: 'lead-1', agentName: 'Milo Reed', projectId: 'app',
    taskId: 'task-open', asOf: NOW });
  assert.deepEqual(fallback.completed.map(row => row.taskId), ['task-done']);
  assert.deepEqual(fallback.remaining.map(row => row.taskId), ['task-open']);
  // A task the sender does not lead or participate in is refused on the named path too.
  const foreign = await handoffFor(host, { agentId: 'lead-1', agentName: 'Milo Reed', projectId: 'app',
    taskId: 'task-nova', asOf: NOW });
  assert.deepEqual(foreign.completed.map(row => row.taskId), ['task-done']);
});

test('an explicitly bound open task is only remaining; a bound foreign or missing task is not replaced', async () => {
  const { app } = fixture({ tasks: [
    task('task-done', '已完成的任务', 'completed', 2, { resultSummary: '已经做完' }),
    task('task-open', '还没做完的任务', 'in_progress', 1),
    task('task-nova', 'Nova 的任务', 'completed', 1, { leadAgentId: 'reviewer-1',
      participants: [{ agentId: 'reviewer-1', role: 'lead', status: 'active' }] })
  ] });
  const host = { handoff: input => roundtableHandoff(app, input) };
  // Named explicitly and still open: it is the work handed off, so unrelated
  // finished work is not substituted and the open task is only remaining.
  const open = await handoffFor(host, { agentId: 'lead-1', agentName: 'Milo Reed', projectId: 'app',
    taskId: 'task-open', bound: true, asOf: NOW });
  assert.deepEqual(open.completed, []);
  assert.deepEqual(open.remaining.map(row => row.taskId), ['task-open']);
  // A bound task that is another Agent's, or does not exist, yields no handoff.
  const foreign = await handoffFor(host, { agentId: 'lead-1', agentName: 'Milo Reed', projectId: 'app',
    taskId: 'task-nova', bound: true, asOf: NOW });
  assert.equal(foreign, null);
  const missing = await handoffFor(host, { agentId: 'lead-1', agentName: 'Milo Reed', projectId: 'app',
    taskId: 'task-missing', bound: true, asOf: NOW });
  assert.equal(missing, null);
});

test('a listed task that belongs to another project is never handoff evidence', async () => {
  const own = task('task-own', '本项目的任务', 'completed', 1);
  const foreignProject = task('task-foreign-project', '别的项目', 'completed', 1, { personalProjectId: 'other-app' });
  const app = {
    config: { personal: { spaceId: 'space' } },
    // The list wrongly returns another project's task this time.
    listProjectAgentTasks: async () => [foreignProject, own]
  };
  const handoff = await roundtableHandoff(app, { agentId: 'lead-1', projectId: 'app',
    since: at(48), until: at(0) });
  assert.deepEqual(handoff.completed.map(row => row.taskId), ['task-own']);
});

test('a long multibyte space id stays inside the cap, keeps the rows and drops the read hint', async () => {
  const { app } = fixture({ tasks: installed() });
  const handoff = await handoffFor({ handoff: input => roundtableHandoff(app, input) },
    { agentId: 'lead-1', agentName: 'Milo Reed', projectId: 'app', asOf: NOW });
  // An actual scope id of 3600 UTF-8 bytes: the rendered hint would blow the cap.
  const spaceId = '空'.repeat(1200);
  const text = handoffText(handoff, { spaceId });
  assert.ok(Buffer.byteLength(text) <= HANDOFF_MAX_BYTES);
  assert.equal(text.includes(spaceId), false);
  // The data rows are kept; only the optional expansion hint is dropped.
  assert.match(text, /task task-installer/);
  assert.match(text, /待接手：启动检查/);
});

test('the handoff stays within ten rows and 2400 UTF-8 bytes, with huge fields clipped', async () => {
  const huge = '长'.repeat(4000);
  const tasks = [
    ...Array.from({ length: 12 }, (_, index) => task(`task-${index}`, `${huge}${index}`, 'completed', index / 10, {
      resultSummary: huge, verifiedArtifactRevision: huge, runId: huge, qualityGate: huge, sourceApplication: huge })),
    ...Array.from({ length: 6 }, (_, index) => task(`open-${index}`, `${huge}open${index}`, 'in_progress', index / 10))
  ];
  const { app } = fixture({ tasks });
  const handoff = await handoffFor({ handoff: input => roundtableHandoff(app, input) },
    { agentId: 'lead-1', agentName: 'Milo Reed', projectId: 'app', asOf: NOW });
  assert.ok(handoff.completed.length + handoff.remaining.length <= 10);
  assert.ok(Buffer.byteLength(JSON.stringify(handoff)) <= HANDOFF_MAX_BYTES);
  const text = handoffText(handoff, { spaceId: 'space' });
  assert.ok(Buffer.byteLength(text) <= HANDOFF_MAX_BYTES);
  assert.ok(text.includes('…'));
  assert.equal(text.includes(huge), false);
});

test('a host without the handoff method leaves the ask and its prompt as they were', async () => {
  const f = fixture({ tasks: installed() });
  // A standalone host implements the port without the optional method.
  const { handoff: _handoff, ...standalone } = f.host;
  let id = 0;
  const roundtable = createAgentRoundtable({ host: standalone, env: {},
    openStore: () => createRoundtableStore(), idFactory: () => `solo-${++id}`, now: () => NOW,
    locateCwd: () => '/work/codex/x', clientAvailable: () => true, groupAlive: () => false,
    wake: async input => { f.woken.push(input); return { body: '收到', sessionId: 'fork-3' }; } });
  const result = await call(roundtable, 'message_agent', { taskContextToken: 'token-milo', sourceApplication: 'claude_code',
    to: 'Nova Lane', body: '没有交接也一样' });
  assert.equal(result.status, 'answered');
  assert.equal(f.woken[0].prompt.includes('接手交接'), false);
});
