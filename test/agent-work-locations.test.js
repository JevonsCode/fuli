import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sessionClientRecords } from '../src/agent-kits/session-clients.js';
import { dispatchGraphTool } from '../src/agent-tools/graph-handlers.js';
import { consoleWorkLocations, summariseWorkLocations } from '../src/graphiti/agent-work-locations.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

// Synthetic spaces, projects, FLAs, conversations and host sessions only.
const session = (client, model, lastSeen, sessionId = `${client}-${lastSeen}`) =>
  ({ client, session_id: sessionId, model, first_seen: lastSeen, last_seen: lastSeen });
const conversation = (id, sessions, extra = {}) =>
  ({ id, summary: 'Amount parser for the ledger import', status: 'incomplete', last_activity: '2026-11-22T10:00:00Z', sessions, ...extra });
const page = (conversations, personalProjectId = 'ledger', limit = 50) => ({ personalProjectId, conversations, limit });

test('one row per client and model, most work first, each with its own segments', () => {
  const found = summariseWorkLocations([page([
    conversation('c1', [session('codex', 'synthetic-model-s', '2026-11-22T09:00:00Z'),
      session('claude_code', 'synthetic-model-c', '2026-11-21T09:00:00Z')]),
    conversation('c2', [session('codex', 'synthetic-model-s', '2026-11-20T09:00:00Z')])
  ])]);
  assert.equal(found.segments, 3);
  assert.deepEqual(found.rows.map(row => [row.client, row.model, row.segments, row.conversations, row.recent.length]),
    [['codex', 'synthetic-model-s', 2, 2, 2], ['claude_code', 'synthetic-model-c', 1, 1, 1]]);
  // A row's segments are exactly the ones it counts, newest first.
  assert.deepEqual(found.rows[0].recent.map(segment => segment.conversation_id), ['c1', 'c2']);
  assert.equal(found.complete, true);
});

test('an unknown model keeps its own row and says why, never blaming the client for what FULI does not read', () => {
  const found = summariseWorkLocations([page([
    conversation('c1', [session('cursor', null, '2026-11-22T09:00:00Z')]),
    conversation('c2', [session('claude_code', null, '2026-11-21T09:00:00Z'),
      session('claude_code', 'synthetic-model-c', '2026-11-21T10:00:00Z')]),
    conversation('c3', [session(null, null, '2026-11-01T10:00:00Z')])
  ])]);
  assert.deepEqual(found.rows.map(row => [row.client, row.model, row.model_reason ?? null]), [
    ['cursor', null, 'not_read'],
    ['claude_code', 'synthetic-model-c', null],
    ['claude_code', null, 'not_recorded'],
    // An older record that never said which client did the work.
    [null, null, 'client_not_recorded']
  ]);
});

test('a requested model is marked as requested, not as what answered', () => {
  const [row] = summariseWorkLocations([page([conversation('c1', [session('codex', 'synthetic-model-s', '2026-11-22T09:00:00Z')])])]).rows;
  assert.equal(row.model_source, 'requested');
  assert.match(summariseWorkLocations([]).guidance, /requested is the model the client asked for/);
});

test('every way the count was cut short is named, per scope', () => {
  const full = Array.from({ length: 50 }, (_, index) => conversation(`full-${index}`, [session('codex', null, '2026-11-22T09:00:00Z')]));
  const found = summariseWorkLocations([page(full, 'ledger'), page([conversation('b1', [session('codex', null, '2026-11-22T09:00:00Z')])], 'billing'),
    page([conversation('crowded', Array.from({ length: 5 }, (_, index) => session('codex', null, `2026-11-2${index}T09:00:00Z`)))], 'reports')]);
  assert.equal(found.complete, false);
  // One project full and two not: the full one is named, not hidden in a total.
  assert.deepEqual(found.truncated, [
    { reason: 'conversations_limit', personal_project_id: 'ledger', read: 50 },
    { reason: 'sessions_per_conversation', conversation_id: 'crowded', read: 5 }]);
});

test('a scope that could not be read is named with its reason and never counted as no work', () => {
  const found = summariseWorkLocations([page([conversation('c1', [session('codex', null, '2026-11-22T09:00:00Z')])]),
    { personalProjectId: 'billing', failed: 'provider_unavailable' }]);
  assert.equal(found.complete, false);
  assert.deepEqual(found.unavailable, [{ personal_project_id: 'billing', reason: 'provider_unavailable' }]);
  assert.equal(found.segments, 1);
});

test('continuing elsewhere takes the newest conversation and says which work and which project', () => {
  const found = summariseWorkLocations([
    page([conversation('older', [], { last_activity: '2026-11-20T09:00:00Z', continuation_prompt: '#FLA {lead} older' })], 'ledger'),
    page([conversation('newer', [], { last_activity: '2026-11-23T09:00:00Z', summary: 'CSV export',
      continuation_prompt: '#FLA {lead} newer' })], 'billing')]);
  assert.deepEqual(found.continuation, { conversation_id: 'newer', personal_project_id: 'billing', title: 'CSV export',
    prompt: '#FLA {lead} newer', opens: 'new_session', leaves_original: true });
  assert.equal(summariseWorkLocations([page([conversation('c3', [])])]).continuation, null);
});

// The console's read: the person's own records across the FLA's active projects.
function consoleApplication({ assignments = ['ledger'], failing = [], assignmentsFail = false, runtimeConfigPath } = {}) {
  const asked = [];
  return { asked, runtimeConfigPath, config: { personal: { spaceId: 'space' } },
    listProjectAgentAssignments: async () => {
      if (assignmentsFail) throw Object.assign(new Error('synthetic'), { code: 'provider_unavailable' });
      return assignments.map(personalProjectId => ({ personalProjectId }));
    },
    personal: { conversation: async (_operation, request) => {
      asked.push(request);
      if (failing.includes(request.personal_project_id)) throw Object.assign(new Error('synthetic'), { code: 'provider_timeout' });
      return { conversations: [conversation(`c-${request.personal_project_id}`,
        [session('claude_code', 'synthetic-model-c', '2026-11-22T09:00:00Z', `session-${request.personal_project_id}`)])] };
    } } };
}

test('console: the FLA\'s active projects, bounded, saying what that leaves out', async () => {
  const app = consoleApplication({ assignments: ['ledger', 'billing', 'reports', 'archive'] });
  const found = await consoleWorkLocations(app, { personalSpaceId: 'space', agentId: 'lead' });
  assert.deepEqual(app.asked.map(request => request.personal_project_id), ['ledger', 'billing', 'reports']);
  assert.ok(app.asked.every(request => request.source_application === null), 'the person reads their own records');
  assert.deepEqual(found.truncated, [{ reason: 'projects_limit', read: 3, total: 4 }, { reason: 'global_scope_not_counted' }]);
});

test('console: a failed project or an unreadable assignment list is said, not shown as no work', async () => {
  const partly = await consoleWorkLocations(consoleApplication({ assignments: ['ledger', 'billing'], failing: ['billing'] }),
    { personalSpaceId: 'space', agentId: 'lead' });
  assert.deepEqual(partly.unavailable, [{ personal_project_id: 'billing', reason: 'provider_timeout' }]);
  assert.equal(partly.segments, 1);
  const none = await consoleWorkLocations(consoleApplication({ assignmentsFail: true }), { personalSpaceId: 'space', agentId: 'lead' });
  assert.equal(none.segments, 0);
  assert.equal(none.complete, false);
  assert.deepEqual(none.unavailable, [{ scope: 'assignments', reason: 'provider_unavailable' }]);
});

test('console: a session this computer\'s own hook recorded is marked as here; any other is unknown, never "elsewhere"', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-work-locations-'));
  try {
    sessionClientRecords(root).record('claude_code', 'session-ledger', { source: 'Claude Code' });
    const found = await consoleWorkLocations(consoleApplication({ assignments: ['ledger', 'billing'],
      runtimeConfigPath: join(root, 'runtime.json') }), { personalSpaceId: 'space', agentId: 'lead' });
    const segments = found.rows.flatMap(row => row.recent);
    assert.equal(segments.find(segment => segment.session_id === 'session-ledger').on_this_computer, true);
    assert.equal(segments.find(segment => segment.session_id === 'session-billing').on_this_computer, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Agents count through list_agent_conversations, with that tool's own scope and checks.
function agentApplication(conversationImpl) {
  const app = new FederatedGraphApplication({ version: 1, personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-test-token', principalId: 'synthetic-user', spaceId: 'space' }, workspaces: [] },
  { fetchImpl: async () => { throw new Error('Unexpected Provider request'); } });
  const asked = [];
  app.personal.conversation = async (operation, request) => { asked.push({ operation, request }); return conversationImpl(request); };
  app.listProjectAgentAssignments = async () => { throw new Error('an Agent count must not expand to other projects'); };
  return { app, asked };
}

test('agent: the count reads only the scope asked for, as the calling client, never as the owner', async () => {
  const { app, asked } = agentApplication(() => ({ conversations: [conversation('c1', [session('codex', 'synthetic-model-s', '2026-11-22T09:00:00Z')])] }));
  const answer = await dispatchGraphTool(app, 'list_agent_conversations', { personalSpaceId: 'space', personalProjectId: 'ledger',
    agentId: 'lead', sourceApplication: 'cursor', workLocations: true });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].request.personal_project_id, 'ledger');
  // The calling client goes to the Provider, which checks the FLA's allowed clients.
  assert.equal(asked[0].request.source_application, 'cursor');
  assert.equal(answer.work_locations.segments, 1);
  assert.equal(answer.conversations.length, 1);
});

test('agent: a Provider refusal is a refusal, never a count of zero', async () => {
  const { app } = agentApplication(() => { throw Object.assign(new Error('Agent is not allowed in this client'), { status: 403 }); });
  await assert.rejects(dispatchGraphTool(app, 'list_agent_conversations', { personalSpaceId: 'space', personalProjectId: 'ledger',
    agentId: 'someone-else', sourceApplication: 'cursor', workLocations: true }), error => error.status === 403);
});

test('agent: without workLocations the list answers exactly as before', async () => {
  const { app } = agentApplication(() => ({ conversations: [] }));
  const answer = await dispatchGraphTool(app, 'list_agent_conversations', { personalSpaceId: 'space', personalProjectId: 'ledger',
    agentId: 'lead', sourceApplication: 'codex' });
  assert.equal('work_locations' in answer, false);
});
