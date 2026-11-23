// rec#39 (macOS field evidence, 0.29.0-beta.9): with the fallback entry,
// get_collaboration_preferences and list_agent_interfaces both answered
// internal_error because the lease request every tool call makes to FULI's
// console was refused (TypeError, cause ECONNREFUSED). The calls go through
// the real MCP tool entries and the real lease client; the console is a
// synthetic fetch in a throwaway data directory, never the running service.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createRuntimeLeaseClient } from '../src/adaptive-runtime/lease-client.js';
import { DEFAULT_ADAPTIVE_RUNTIME_SETTINGS } from '../src/adaptive-runtime/settings.js';
import { diagnosticEventLog } from '../src/diagnostics/event-log.js';
import { diagnosticEventsAnswer } from '../src/diagnostics/query.js';
import { recordPersonStop, updateConsoleAutostart } from '../src/local-runtime/console-autostart-record.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

const LEASE = '11111111-1111-4111-8111-111111111111';
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2828'), { code: 'ECONNREFUSED' }) });
const consoleAnswers = (init) => Response.json(init.method === 'POST' ? { enabled: true, leaseId: LEASE } : { released: true });

async function connected(t, { fetchImpl, state = { url: 'http://127.0.0.1:2828' }, toolProfile = 'chat', tools = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fuli-console-unreachable-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(dir, 'graph-runtime.json');
  await writeFile(runtimeConfigPath, '{}');
  const diagnosticEvents = diagnosticEventLog(dir);
  const leaseClient = createRuntimeLeaseClient({ runtimeConfigPath,
    paths: { adaptiveRuntimeSettingsPath: join(dir, 'adaptive.json'), graphRuntimeStatePath: join(dir, 'state.json') },
    readSettings: () => ({ ...DEFAULT_ADAPTIVE_RUNTIME_SETTINGS, enabled: true }),
    readJson: () => state, fetchImpl: (url, init) => fetchImpl(url, init),
    setHeartbeat: () => ({ unref() {} }), clearHeartbeat: () => {} });
  const app = { config: { personal: { spaceId: 'synthetic-space' } }, diagnosticEvents,
    getCollaborationPreferences: async () => ({ effective_preferences: [], taskContextToken: 'fuli-task-synthetic',
      agent_receipt: { required: true, markdown: 'FULI Agent：Synthetic' } }), ...tools };
  const server = createMcpServer(app, { env: {}, sourceApplication: 'claude_code', toolProfile, registerResources: false,
    withRuntimeLease: leaseClient.withGraphLease });
  const client = new Client({ name: 'fuli-console-unreachable-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await leaseClient.close(); });
  return { dir, client,
    entry: () => client.callTool({ name: 'get_collaboration_preferences', arguments: {
      projectPath: '/synthetic/project', taskPrompt: 'synthetic request', sessionId: 'synthetic-session' } }),
    interfaces: () => client.callTool({ name: 'list_agent_interfaces', arguments: { toolName: 'read_diagnostic_events' } }),
    events: () => diagnosticEventsAnswer(diagnosticEvents).events };
}

const failureOf = (result) => ({ code: result.structuredContent?.error?.code, message: result.structuredContent?.error?.message });

for (const toolProfile of ['chat', 'full']) {
  test(`${toolProfile} profile: a refused console is said as runtime_unavailable by both tool entries, with nothing to rely on and one bounded step`, async (t) => {
    const { entry, interfaces, events } = await connected(t, { toolProfile, fetchImpl: async () => { throw refused(); } });
    for (const call of [entry, interfaces]) {
      const result = await call();
      assert.equal(result.isError, true);
      const { code, message } = failureOf(result);
      assert.equal(code, 'runtime_unavailable');
      assert.match(message, /^FULI's console refused the connection; nothing ran: no task, token or receipt\. It may restart by itself: retry once in a few seconds; if it fails again, tell the person to start FULI \(`fuli start`\)\. Never reuse an old token\.$/);
      assert.ok(message.length <= 240, `${message.length} chars`);
      assert.doesNotMatch(JSON.stringify(result), /2828|127\.0\.0\.1|ECONNREFUSED|TypeError|fetch failed|taskContextToken|fuli-task-|agent_receipt/);
      assert.equal(result.structuredContent.taskContextToken, undefined, 'no token and no receipt to use');
    }
    const [second, first] = events();
    assert.deepEqual([first.operation, first.code, first.outcome], ['get_collaboration_preferences', 'runtime_unavailable', 'failed']);
    assert.deepEqual([second.operation, second.code], ['list_agent_interfaces', 'runtime_unavailable']);
    assert.match(first.reason, /^FULI's console refused the connection; nothing ran/);
    assert.doesNotMatch(JSON.stringify(events()), /2828|127\.0\.0\.1|synthetic request|synthetic-session/);
  });
}

test('the same MCP connection works again once the console answers: one retry enters the task and lists the interface', async (t) => {
  let up = false;
  const { entry, interfaces } = await connected(t, { fetchImpl: async (_url, init) => { if (!up) throw refused(); return consoleAnswers(init); } });
  assert.equal(failureOf(await entry()).code, 'runtime_unavailable');
  assert.equal(failureOf(await interfaces()).code, 'runtime_unavailable');
  up = true;
  const entered = await entry();
  assert.equal(entered.isError, undefined);
  assert.match(JSON.stringify(entered.structuredContent), /fuli-task-synthetic/);
  const listed = await interfaces();
  assert.equal(listed.isError, undefined);
  assert.match(JSON.stringify(listed.structuredContent), /read_diagnostic_events/);
});

test('a healthy console changes nothing: both entries answer as before and the lease is released', async (t) => {
  const methods = [];
  const { entry, interfaces } = await connected(t, { fetchImpl: async (_url, init) => { methods.push(init.method); return consoleAnswers(init); } });
  assert.equal((await entry()).isError, undefined);
  assert.equal((await interfaces()).isError, undefined);
  assert.deepEqual(methods, ['POST', 'DELETE', 'POST', 'DELETE']);
});

test('a console that does not answer in time, one that was never started, and a person who stopped it each say their own reason and step', async (t) => {
  const timeout = await connected(t, { fetchImpl: async () => { throw Object.assign(new Error('synthetic'), { name: 'TimeoutError' }); } });
  assert.match(failureOf(await timeout.entry()).message, /^FULI's console did not answer in time; nothing ran: no task, token or receipt\. It may restart by itself: retry once/);

  const notStarted = await connected(t, { state: null, fetchImpl: async () => { throw new Error('never reached'); } });
  assert.match(failureOf(await notStarted.interfaces()).message, /^FULI's console is not running; nothing ran/);

  const stopped = await connected(t, { fetchImpl: async () => { throw refused(); } });
  recordPersonStop(stopped.dir);
  const held = failureOf(await stopped.entry());
  assert.equal(held.code, 'runtime_unavailable');
  assert.match(held.message, /Tell the person once to start FULI \(`fuli start`\); do not retry\. Never reuse an old token\.$/);
  assert.doesNotMatch(held.message, /restart by itself/);
  assert.ok(held.message.length <= 240);
});

test('an unrelated internal error stays redacted, and a caller\'s own abort is not called a console failure', async (t) => {
  const broken = await connected(t, { fetchImpl: async (_url, init) => consoleAnswers(init),
    tools: { getCollaborationPreferences: async () => { throw new TypeError('synthetic secret path /Users/someone/key and a prompt'); } } });
  const result = await broken.entry();
  assert.deepEqual(failureOf(result), { code: 'internal_error', message: 'Tool execution failed' });
  assert.doesNotMatch(JSON.stringify(result), /secret|Users|prompt/);

  const aborted = await connected(t, { fetchImpl: async (_url, init) => {
    throw init.signal?.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
  const refusal = await aborted.client.callTool({ name: 'list_agent_interfaces', arguments: {} },
    undefined, { signal: AbortSignal.abort(new Error('caller gave up')) }).then(() => null, error => error);
  assert.ok(refusal === null || !/runtime_unavailable/.test(String(refusal?.message ?? '')), 'a caller\'s abort stays its own');
});

// The step follows what the automatic start recorded (consoleAutostartHold), reusing its state.
const hold = (dir, reason) => updateConsoleAutostart(dir, record => ({ ...record, held: { reason, at: new Date().toISOString() } }));

test('a data format update that waits asks for its confirmation: both tool entries and the diagnostics say so, once, with the fixed wording', async (t) => {
  const { dir, entry, interfaces, events } = await connected(t, { fetchImpl: async () => { throw refused(); } });
  hold(dir, 'data_format');
  for (const call of [entry, interfaces]) {
    const result = await call();
    const { code, message } = failureOf(result);
    assert.equal(code, 'runtime_unavailable');
    assert.equal(message, "FULI's console refused the connection; nothing ran: no task, token or receipt. "
      + 'Tell the person once to start FULI and confirm the update in Settings › Data format; do not retry. Never reuse an old token.');
    assert.ok(message.length <= 240);
    assert.doesNotMatch(JSON.stringify(result), /2828|127\.0\.0\.1|ECONNREFUSED|TypeError|fetch failed|fuli-task-|agent_receipt/);
  }
  const [second, first] = events();
  assert.deepEqual([first.operation, first.code, first.outcome], ['get_collaboration_preferences', 'runtime_unavailable', 'failed']);
  assert.deepEqual([second.operation, second.code], ['list_agent_interfaces', 'runtime_unavailable']);
  for (const event of [first, second]) {
    assert.match(event.reason, /confirm the update in Settings › Data format; do not retry/);
    assert.doesNotMatch(JSON.stringify(event), /2828|127\.0\.0\.1|synthetic request|synthetic-session/);
  }
});

test('gave up asks for a start; with no recorded state nothing is promised but one bounded retry', async (t) => {
  const gaveUp = await connected(t, { fetchImpl: async () => { throw refused(); } });
  hold(gaveUp.dir, 'gave_up');
  assert.match(failureOf(await gaveUp.entry()).message, /Tell the person once to start FULI \(`fuli start`\); do not retry\./);

  const bounded = /It may restart by itself: retry once in a few seconds; if it fails again, tell the person to start FULI \(`fuli start`\)\. Never reuse an old token\.$/;
  // Nothing recorded, an unreadable record (the automatic start cannot say what it did) and a data directory
  // that was never set up all leave the state unknown: no promise that FULI starts itself again.
  const none = await connected(t, { fetchImpl: async () => { throw refused(); } });
  assert.match(failureOf(await none.entry()).message, bounded);
  const unreadable = await connected(t, { fetchImpl: async () => { throw refused(); } });
  await writeFile(join(unreadable.dir, 'console-autostart.json'), '{not json');
  const answer = failureOf(await unreadable.interfaces());
  assert.match(answer.message, bounded);
  assert.doesNotMatch(answer.message, /restarts by itself|Settings/);
  const notSet = await connected(t, { state: null, fetchImpl: async () => { throw new Error('never reached'); } });
  const notRunning = failureOf(await notSet.entry());
  assert.match(notRunning.message, /^FULI's console is not running; nothing ran/);
  assert.match(notRunning.message, bounded);
});
