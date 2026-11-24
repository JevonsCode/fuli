import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { activeRunnerCaller, runAsRunnerCall, runWithAgentRequestContext } from '../src/app/agent-request-context.js';
import { createDelegatedConsoleClient } from '../src/agent-delegation/console-client.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { CALL_TIMEOUT_MS, RUNNER_ENTRY_META, RUNNER_PATHS } from '../src/runner/protocol.js';

const RUNNER_A = 'a'.repeat(64);
const RUNNER_B = 'b'.repeat(64);

// The runner routes behind plain HTTP on loopback, the device fingerprint
// taken from a test header (the TLS listener reads it from the certificate).
async function serve(t, routes) {
  const server = createServer((request, response) => {
    const fingerprint = request.headers['x-test-fingerprint'];
    const { pathname } = new URL(request.url, 'http://runner.invalid');
    routes.handle(request, response, { fingerprint, pathname, address: '192.168.1.30' }).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await routes.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (fingerprint, path, body) => {
    const answer = await fetch(`${origin}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-fingerprint': fingerprint }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  return { origin, post };
}

function pairedStore(...fingerprints) {
  const store = new RunnerHostStore(':memory:');
  for (const [index, fingerprint] of fingerprints.entries()) {
    const code = `synthetic-invitation-code-${index}`;
    store.invite({ code, name: `Runner ${index}` });
    store.pair({ code, fingerprint, deviceName: `device-${index}` });
  }
  return store;
}

const entry = (id) => ({ id, tool: 'checkpoint_task_knowledge', input: { taskContextToken: 'host-token', disposition: 'retain_nothing' },
  sourceApplication: 'codex', sessionId: 'synthetic-session', offlineTask: null });

test('two concurrent deliveries of one entry apply it once; the second waits, a later one gets the first answer', async (t) => {
  const applied = [];
  const release = Promise.withResolvers();
  const routes = createRunnerRoutes({ app: {}, store: pairedStore(RUNNER_A), hostName: 'Host', hostFingerprint: 'f'.repeat(64),
    withLease: (_owner, operation) => operation(),
    runTool: async (_app, toolName) => {
      applied.push({ toolName, runner: activeRunnerCaller() });
      await release.promise;
      return { status: 'recorded' };
    } });
  const { post } = await serve(t, routes);

  const first = post(RUNNER_A, RUNNER_PATHS.replay, entry('entry-1'));
  while (!applied.length) await new Promise((resolve) => setImmediate(resolve));
  const second = await post(RUNNER_A, RUNNER_PATHS.replay, entry('entry-1'));
  release.resolve();
  const answered = await first;
  const later = await post(RUNNER_A, RUNNER_PATHS.replay, entry('entry-1'));

  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'replay_pending');
  assert.deepEqual(answered, { status: 200, body: { result: { status: 'recorded' } } });
  assert.deepEqual(later, { status: 200, body: { result: { status: 'recorded' }, replayedBefore: true } });
  assert.deepEqual(applied, [{ toolName: 'checkpoint_task_knowledge', runner: RUNNER_A }]);
});

test('an entry id is the runner\'s own: another runner sending it gets nothing of the first', async (t) => {
  let count = 0;
  const routes = createRunnerRoutes({ app: {}, store: pairedStore(RUNNER_A, RUNNER_B), hostName: 'Host',
    hostFingerprint: 'f'.repeat(64), withLease: (_owner, operation) => operation(),
    runTool: async () => ({ status: 'recorded', applied: ++count, runner: activeRunnerCaller() }) });
  const { post } = await serve(t, routes);

  const fromA = await post(RUNNER_A, RUNNER_PATHS.replay, entry('shared-id'));
  const fromB = await post(RUNNER_B, RUNNER_PATHS.replay, entry('shared-id'));

  assert.deepEqual(fromA.body, { result: { status: 'recorded', applied: 1, runner: RUNNER_A } });
  assert.deepEqual(fromB.body, { result: { status: 'recorded', applied: 2, runner: RUNNER_B } });
});

test('an entry the host failed to apply is free again, so its next delivery applies it', async (t) => {
  let attempts = 0;
  const routes = createRunnerRoutes({ app: {}, store: pairedStore(RUNNER_A), hostName: 'Host', hostFingerprint: 'f'.repeat(64),
    withLease: (_owner, operation) => operation(),
    runTool: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('synthetic provider failure');
      return { status: 'recorded' };
    } });
  const { post } = await serve(t, routes);

  assert.equal((await post(RUNNER_A, RUNNER_PATHS.replay, entry('entry-2'))).status, 500);
  assert.deepEqual(await post(RUNNER_A, RUNNER_PATHS.replay, entry('entry-2')), { status: 200, body: { result: { status: 'recorded' } } });
});

// The host's MCP server, reduced to a checkpoint that runs through the session's lease as create-mcp-server.js does.
function checkpointTools(seen, applied) {
  return (_app, options) => {
    seen.push(options);
    const server = new Server({ name: 'fuli', version: 'test' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
      { name: 'checkpoint_task_knowledge', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const value = await options.withRuntimeLease('mcp-tool:checkpoint_task_knowledge', async () => {
        applied.push(activeRunnerCaller());
        return { status: 'recorded', applied: applied.length };
      }, extra);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    });
    return server;
  };
}

test('a runner\'s MCP session gets no environment of the console, runs as that runner, and applies a checkpoint id once with its replay', async (t) => {
  const seen = [];
  const applied = [];
  const routes = createRunnerRoutes({ app: {}, store: pairedStore(RUNNER_A), hostName: 'Host', hostFingerprint: 'f'.repeat(64),
    withLease: (_owner, operation) => operation(), createMcp: checkpointTools(seen, applied),
    runTool: async () => { applied.push('replayed'); return { status: 'recorded' }; } });
  const { origin, post } = await serve(t, routes);
  const client = new Client({ name: 'runner-test', version: 'test' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}${RUNNER_PATHS.mcp}`),
    { requestInit: { headers: { 'x-test-fingerprint': RUNNER_A } } }));
  t.after(() => client.close());

  const online = await client.callTool({ name: 'checkpoint_task_knowledge', arguments: {}, _meta: { [RUNNER_ENTRY_META]: 'online-1' } });
  const again = await client.callTool({ name: 'checkpoint_task_knowledge', arguments: {}, _meta: { [RUNNER_ENTRY_META]: 'online-1' } });
  const replayed = await post(RUNNER_A, RUNNER_PATHS.replay, entry('online-1'));

  assert.deepEqual(seen[0].env, {});
  assert.deepEqual(online.structuredContent, { status: 'recorded', applied: 1 });
  assert.deepEqual(again.structuredContent, { status: 'recorded', applied: 1 });
  assert.deepEqual(replayed.body, { result: { status: 'recorded', applied: 1 }, replayedBefore: true });
  assert.deepEqual(applied, [RUNNER_A]);
});

test('a checkpoint call names its owner and passes the call\'s _meta to the session lease', async (t) => {
  const leases = [];
  const server = createMcpServer({}, { sourceApplication: 'codex', hostSessionId: 'synthetic-session', registerResources: false,
    withRuntimeLease: (owner, _operation, context) => {
      leases.push({ owner, entry: context?._meta?.[RUNNER_ENTRY_META] });
      return { status: 'recorded' };
    } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'lease-test', version: 'test' });
  await client.connect(clientSide);
  t.after(() => client.close());

  await client.callTool({ name: 'checkpoint_task_knowledge', arguments: { taskContextToken: 'host-token',
    disposition: 'retain_nothing', reason: 'Synthetic routine task' }, _meta: { [RUNNER_ENTRY_META]: 'online-2' } });

  assert.deepEqual(leases, [{ owner: 'mcp-tool:checkpoint_task_knowledge', entry: 'online-2' }]);
});

test('a runner\'s call makes no console change: run_delegated_action never reaches the console from it', async () => {
  const sent = [];
  const delegated = createDelegatedConsoleClient({ consoleUrl: () => 'http://127.0.0.1:9/',
    fetchImpl: async (url) => { sent.push(url); return new Response('{}', { status: 200 }); } });
  const change = { method: 'PUT', path: '/api/system/settings', body: {}, call: { actor: {}, reason: 'synthetic', bodyFields: [] } };

  await assert.rejects(runAsRunnerCall(RUNNER_A, () => delegated.send(change)), { code: 'local_user_only', status: 403 });
  assert.deepEqual(sent, []);
  await delegated.send(change);
  assert.equal(sent.length, 1);
});

test('a runner\'s call stays the runner\'s inside the Agent request it runs, and no other call is one', async () => {
  const inner = await runAsRunnerCall(RUNNER_A, () => runWithAgentRequestContext({}, async () => activeRunnerCaller()));
  assert.equal(inner, RUNNER_A);
  assert.equal(await runWithAgentRequestContext({}, async () => activeRunnerCaller()), null);
  assert.equal(activeRunnerCaller(), null);
});

test('a pending entry id is held past the longest call, and freed at once by a host that started again', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-runner-pending-'));
  const file = join(directory, 'host.sqlite');
  let now = Date.parse('2026-11-18T00:00:00Z');
  const first = new RunnerHostStore(file, { now: () => now });
  const restarted = new RunnerHostStore(file, { now: () => now });
  t.after(() => { first.close(); restarted.close(); rmSync(directory, { recursive: true, force: true }); });
  const claim = (store) => store.claimReplay({ runner: RUNNER_A, id: 'entry-x', tool: 'checkpoint_task_knowledge' }).state;

  assert.equal(claim(first), 'claimed');
  now += CALL_TIMEOUT_MS;
  assert.equal(claim(first), 'pending', 'still being applied after the longest call a runner waits for');
  now += 6 * 60_000;
  assert.equal(claim(first), 'claimed', 'held too long: the process lost it');

  assert.equal(claim(restarted), 'claimed', 'a host that started again applies it again at once');
});
