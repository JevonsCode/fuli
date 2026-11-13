import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { wakeArguments } from '../packages/roundtable/src/roundtable/wake.js';
import { wakeFailure } from '../packages/roundtable/src/roundtable/wake-failure.js';
import { diagnosticEventLog } from '../src/diagnostics/event-log.js';
import { diagnosticEventsAnswer } from '../src/diagnostics/query.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';

// Synthetic only: no real client starts; the wake port is a fake that records its input.
const SECRET_PATH = '/home/synthetic-person/private/notes.txt';

function fixture(t, { wake, fuliMcp = null, shareClients = ['codex', 'claude_code'], issueGrant = null, sessions = [{ client: 'codex', sessionId: 'synthetic-codex-session' }] } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'fuli-remote-ladder-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = createRoundtableStore();
  const diagnosticEvents = diagnosticEventLog(folder);
  const woken = [];
  const grants = [];
  const app = {
    config: { personal: { spaceId: 'fixture-space' } },
    diagnosticEvents,
    listProjectAgents: async () => [{ agentId: 'shared-lead',
      profile: { name: 'Shared lead', status: 'active', allowedClients: ['codex', 'claude_code'] } }],
    personal: {
      recentAgentSessions: async () => sessions.map(session => ({ source_application: session.client,
        session_id: session.sessionId, personal_project_id: 'shared-project' })),
      verifyAgentDelegation: async () => ({ redeemed: true }), revokeAgentDelegation: async () => {}, sealAgentDelegation: async () => {}
    }
  };
  if (fuliMcp) app.fuliMcpServer = fuliMcp;
  const service = createAgentRoundtable({ host: createFuliRoundtableHost(app), openStore: () => store, clientAvailable: () => true,
    locateCwd: () => folder, turnRunning: () => false,
    wake: async input => { woken.push(input); return wake(input, woken.length); } });
  t.after(() => service.close());
  const ask = (messageId = 'remote-ask') => service.answerRemote({
    claim: { messageId, attemptId: 'fixture-attempt', sender: { nodeId: 'c'.repeat(64), name: 'Fixture peer' },
      assertion: { messageId, threadId: 'remote-thread', body: 'Question', conversation: 'auto', depth: 1,
        from: { agentId: 'peer-lead', name: 'Peer lead' } } },
    share: { spaceId: 'fixture-space', bindingId: 'shared-binding', agentId: 'shared-lead', projectId: 'shared-project',
      clients: shareClients, workingDirectory: folder },
    issueGrant: async (delivery, lifetime) => { grants.push({ client: delivery.client, lifetime });
      return issueGrant ? issueGrant(delivery, grants.length) : { token: `grant-${grants.length}` }; },
    timeoutMs: 900_000 });
  return { store, service, woken, grants, ask, diagnosticEvents };
}

const crash = () => { throw wakeFailure('wake_failed', 'client_exit_nonzero', 'synthetic', { exitCode: 1,
  output: { stderr: `cannot open ${SECRET_PATH}` } }); };

test('an answer stands when its wake record cannot be kept', async (t) => {
  const f = fixture(t, { wake: () => ({ body: 'Synthetic answer', sessionId: 'synthetic-codex-session' }) });
  f.store.wakeAttempts.record = () => { throw new Error('synthetic disk full'); };
  assert.equal((await f.ask()).body, 'Synthetic answer');
});

test('a remote ask tries a new session in its client, then the share\'s other client, each with its own grant', async (t) => {
  const f = fixture(t, { wake: (input, n) => n < 3 ? crash() : { body: 'Synthetic answer', sessionId: 'synthetic-claude-session' } });
  const answer = await f.ask();
  assert.equal(answer.via, 'claude_code:new');
  assert.deepEqual(f.woken.map(input => [input.client, input.sessionId]),
    [['codex', 'synthetic-codex-session'], ['codex', null], ['claude_code', null]]);
  assert.deepEqual(f.grants.map(grant => grant.client), ['codex', 'codex', 'claude_code']);
  assert.deepEqual(new Set(f.woken.map(input => input.delegationToken)).size, 3, 'each wake has its own grant');
});

test('a remote ask no rung answers returns the last code and how many wakes it tried; each is kept where it ran', async (t) => {
  const f = fixture(t, { shareClients: ['claude_code', 'codex'], wake: crash });
  const error = await f.ask().then(() => assert.fail('answered'), error => error);
  assert.deepEqual([error.code, error.detail, error.attempts], ['wake_failed', 'client_exit_nonzero', 3]);
  // Resume first, then a new session in the same client, then the share's next client.
  assert.deepEqual(f.woken.map(input => [input.client, input.sessionId]),
    [['codex', 'synthetic-codex-session'], ['codex', null], ['claude_code', null]]);
  const status = await f.service.ownerMessageStatus({ messageId: f.store.listThreads('fixture-space')
    .flatMap(thread => f.store.messages(thread.id))[0].id });
  assert.deepEqual(status.wakeAttempts.map(attempt => [attempt.attempt, attempt.client, attempt.sessionMode, attempt.detail, attempt.exitCode]),
    [[1, 'codex', 'resumed', 'client_exit_nonzero', 1], [2, 'codex', 'new', 'client_exit_nonzero', 1],
      [3, 'claude_code', 'new', 'client_exit_nonzero', 1]]);
  for (const attempt of status.wakeAttempts) assert.match(attempt.outputSummary, /^cannot open \[path\]$/);
  const events = diagnosticEventsAnswer(f.diagnosticEvents, { component: 'roundtable' }).events;
  assert.equal(events.length, 3);
  assert.deepEqual([events[0].code, events[0].outcome], ['client_exit_nonzero', 'failed']);
  assert.ok(events.every(event => !JSON.stringify(event).includes('synthetic-person')), 'diagnostics carry no client output');
});

test('without a session to resume, new sessions follow the share\'s client order', async (t) => {
  const f = fixture(t, { sessions: [], wake: crash });
  await assert.rejects(f.ask(), { code: 'wake_failed', detail: 'client_exit_nonzero', attempts: 2 });
  assert.deepEqual(f.woken.map(input => [input.client, input.sessionId]), [['codex', null], ['claude_code', null]]);
});

test('a refused grant, a cancel or the team rules end a remote ask at once', async (t) => {
  const refused = fixture(t, { wake: crash, issueGrant: (_delivery, n) => {
    if (n > 1) throw Object.assign(new Error('Remote devices can only ask the project lead'), { code: 'lead_changed', status: 403 });
    return { token: 'grant-1' };
  } });
  await assert.rejects(refused.ask(), { code: 'lead_changed' });
  assert.equal(refused.woken.length, 1);

  const cancelled = fixture(t, { wake: () => { throw wakeFailure('cancelled', 'cancelled', 'synthetic'); } });
  await assert.rejects(cancelled.ask(), { code: 'cancelled', detail: 'cancelled' });
  assert.equal(cancelled.woken.length, 1);

  const forbidden = fixture(t, { wake: () => { throw Object.assign(new Error('synthetic'), { status: 403 }); } });
  await assert.rejects(forbidden.ask(), { code: 'not_permitted' });
  assert.equal(forbidden.woken.length, 1);
});

test('a remote ask wakes every client read-only, with each adapter\'s read-only arguments', async (t) => {
  const f = fixture(t, { wake: (input, n) => n < 3 ? crash() : { body: 'Synthetic answer', sessionId: 'synthetic-claude-session' } });
  await f.ask();
  assert.ok(f.woken.every(input => input.mode === 'read_only'));
  const codexResume = wakeArguments('codex', f.woken[0]);
  const codexNew = wakeArguments('codex', f.woken[1]);
  const claude = wakeArguments('claude_code', f.woken[2]);
  assert.ok(codexResume.includes('sandbox_mode="read-only"'));
  assert.deepEqual(codexNew.slice(codexNew.indexOf('--sandbox'), codexNew.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.deepEqual(claude.slice(claude.indexOf('--tools'), claude.indexOf('--tools') + 4),
    ['--tools', 'Read,Grep,Glob', '--disallowedTools', 'Edit,Write,NotebookEdit,MultiEdit,Bash,PowerShell']);
});

test('an ask from another computer loads only FULI\'s own MCP server where FULI can name it', async (t) => {
  const entry = (client) => ({ command: 'synthetic-node', args: ['synthetic-mcp-server.js', '--source-application', client] });
  const f = fixture(t, { fuliMcp: entry, wake: () => ({ body: 'Synthetic answer', sessionId: 'synthetic-codex-session' }) });
  await f.ask();
  assert.deepEqual([f.woken[0].mode, f.woken[0].mcpServer], ['read_only', entry(f.woken[0].client)]);
  const bare = fixture(t, { wake: () => ({ body: 'Synthetic answer', sessionId: 'synthetic-codex-session' }) });
  await bare.ask();
  assert.equal(bare.woken[0].mcpServer, null, 'without the entry a read-only wake keeps today\'s configuration');
});
