import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema }
  from '@modelcontextprotocol/sdk/types.js';

import { createDeviceCertificate, deviceIdentity, loadDeviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { createHostConnection } from '../src/runner/host-connection.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { joinHost } from '../src/runner/join.js';
import { encodeInvitation, newInvitationCode } from '../src/runner/protocol.js';
import { runRunnerMcp } from '../src/runner/runner-mcp.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';
import { reachableModules } from '../test-support/module-graph.js';

// A runner's MCP server while its host is away, slow, or back (docs/runner.md).
// The host is a real runner listener on loopback with a reduced MCP server: its
// task entry carries a receipt and a checkpoint duty, as a real entry does.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST_TOOLS = ['get_collaboration_preferences', 'checkpoint_task_knowledge', 'search_current_project_knowledge'];

// serve: false pairs only; the caller starts the runner's MCP server itself.
// replayHangs: the host takes an outbox entry and never answers it.
async function pairedRunner(t, { listDelayMs = 0, toolsWaitMs, checkpointWaitMs, serve = true, replayHangs = false } = {}) {
  const host = deviceIdentity(await createDeviceCertificate());
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-away-')));
  const calls = [];
  const replayed = [];
  const store = new RunnerHostStore(':memory:');
  const routes = createRunnerRoutes({ app: {}, store, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation(),
    createMcp: () => {
      const server = new Server({ name: 'fuli', version: 'test' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        await delay(listDelayMs);
        return { tools: HOST_TOOLS.map((name) => ({ name, inputSchema: { type: 'object' } })) };
      });
      server.setRequestHandler(CallToolRequestSchema, (request) => {
        const { name, arguments: input } = request.params;
        calls.push({ name, input });
        const value = name === 'get_collaboration_preferences'
          ? { effective_preferences: ['short answers'], taskContextToken: 'host-token-1', checkpoint_required: true,
            agent_receipt: { required: true, markdown: 'earlier task receipt' } }
          : { status: 'recorded' };
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      });
      return server;
    },
    runTool: async (_app, toolName, input) => {
      replayed.push({ toolName, input });
      if (replayHangs) await new Promise(() => {});
      return toolName === 'begin_task_context' ? { taskContextToken: 'host-token-2' } : { status: 'recorded' };
    } });
  // The host away: its listener stays bound (no port is closed and taken again)
  // and drops every request, as a host that went off the network does.
  const state = { away: false };
  state.listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: (request, response, context) => {
      if (!state.away) return routes.handle(request, response, context);
      request.socket.destroy();
      return true;
    } });
  const port = state.listener.port;
  const code = newInvitationCode();
  store.invite({ code, name: 'Runner B' });
  const dataDir = path.join(base, 'runner-data');
  await joinHost({ dataDir, invitation: encodeInvitation({ name: 'Host A', addresses: ['127.0.0.1'], port,
    certPem: host.certPem, code }) });
  const projectPath = path.join(base, 'widgets');
  mkdirSync(projectPath);
  const stopHost = async () => {
    await state.listener.close();
    await routes.close();
    store.close();
    rmSync(base, { recursive: true, force: true });
  };
  if (!serve) {
    t.after(stopHost);
    return { dataDir, calls };
  }

  const client = new Client({ name: 'codex', version: 'test' });
  const listChanged = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged.push(Date.now()); });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = await runRunnerMcp({ dataDir, sourceApplication: 'codex', transport: serverSide,
    lookUp: async () => [], retryAfterMs: 0, toolsWaitMs, checkpointWaitMs });
  await client.connect(clientSide);
  // In this order, the folder last: Windows refuses to delete a SQLite file that is still open.
  t.after(async () => {
    await client.close();
    await served.close();
    await stopHost();
  });
  return { client, calls, replayed, listChanged, served, state, projectPath, dataDir, store, routes,
    hostAway: () => { state.away = true; }, hostBack: () => { state.away = false; } };
}

test('an offline task entry repeats the folder\'s preferences, not the earlier task\'s receipt or checkpoint duty', async (t) => {
  const runner = await pairedRunner(t);
  const online = await runner.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: 'first' } });
  assert.equal(online.structuredContent.agent_receipt.markdown, 'earlier task receipt');

  await runner.hostAway();
  const offline = await runner.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: 'second' } });

  assert.deepEqual(offline.structuredContent.effective_preferences, ['short answers']);
  assert.equal(offline.structuredContent.agent_receipt, undefined);
  assert.equal(offline.structuredContent.checkpoint_required, false);
  assert.match(offline.structuredContent.checkpoint_guidance, /queued_offline/);
  assert.match(offline.structuredContent.taskContextToken, /^runner-offline-/);
});

test('once the host is back, calls under an offline token go to it and a checkpoint is answered as delivered', async (t) => {
  const runner = await pairedRunner(t);
  await runner.hostAway();
  const entry = await runner.client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: runner.projectPath, taskPrompt: 'offline' } });
  const offlineToken = entry.structuredContent.taskContextToken;
  const queued = await runner.client.callTool({ name: 'checkpoint_task_knowledge',
    arguments: { taskContextToken: offlineToken, retain_nothing: true } });
  assert.equal(queued.structuredContent.status, 'queued_offline');

  await runner.hostBack();
  const search = await runner.client.callTool({ name: 'search_current_project_knowledge',
    arguments: { taskContextToken: offlineToken, query: 'deploy steps' } });
  assert.equal(search.isError, undefined);
  assert.deepEqual(runner.calls.at(-1), { name: 'search_current_project_knowledge', input: { query: 'deploy steps' } },
    'the host never sees the runner\'s offline token');

  const checkpoint = await runner.client.callTool({ name: 'checkpoint_task_knowledge',
    arguments: { taskContextToken: offlineToken, workLog: 'amended' } });
  assert.equal(checkpoint.structuredContent.status, 'delivered');
  assert.deepEqual(runner.replayed.map(({ toolName }) => toolName),
    ['begin_task_context', 'checkpoint_task_knowledge', 'begin_task_context', 'checkpoint_task_knowledge'],
    'the earlier queued checkpoint went first');
  assert.equal(runner.served.store.outbox().queued, 0);
});

test('a host slow to list its tools does not hold up the client: it gets the known list, then a list change', async (t) => {
  // Wide margins: a loaded CI machine is slow, and only "before the host answered" matters.
  const runner = await pairedRunner(t, { listDelayMs: 6000, toolsWaitMs: 200 });
  const at = Date.now();
  const listed = await runner.client.listTools();
  assert.ok(Date.now() - at < 5000, `answered after ${Date.now() - at} ms`);
  assert.ok(listed.tools.some((tool) => tool.name === 'get_collaboration_preferences'));

  for (let waited = 0; !runner.listChanged.length && waited < 20_000; waited += 50) await delay(50);
  assert.equal(runner.listChanged.length, 1, 'the client is told to list again once the host answered');
  assert.deepEqual((await runner.client.listTools()).tools.map((tool) => tool.name), HOST_TOOLS);
});

test('the known addresses are tried at once, so one that never answers does not hold up the one that does', async (t) => {
  const host = deviceIdentity(await createDeviceCertificate());
  const store = new RunnerHostStore(':memory:');
  const routes = createRunnerRoutes({ app: {}, store, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation() });
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, route: routes.handle,
    sourceAllowed: () => true });
  // An address that takes the connection and never says a word, first in line as the last that answered.
  const held = new Set();
  const silent = createNetServer((socket) => held.add(socket));
  await new Promise((resolve) => silent.listen(listener.port, '127.0.0.2', resolve));
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-probe-')));
  const code = newInvitationCode();
  store.invite({ code, name: 'Runner B' });
  const dataDir = path.join(base, 'runner-data');
  await joinHost({ dataDir, invitation: encodeInvitation({ name: 'Host A', addresses: ['127.0.0.1'], port: listener.port,
    certPem: host.certPem, code }) });
  const runnerStore = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  runnerStore.saveHost({ name: 'Host A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port,
    addresses: ['127.0.0.2', '127.0.0.1'], lastAddress: '127.0.0.2' });
  const identity = await loadDeviceIdentity(path.join(dataDir, 'peer'));
  // A probe budget far above the margin below, so only parallel probing passes.
  const connection = createHostConnection({ store: runnerStore, identity, lookUp: async () => [], probeMs: 15_000 });
  t.after(async () => {
    connection.close();
    runnerStore.close();
    for (const socket of held) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
    await listener.close();
    await routes.close();
    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  const at = Date.now();
  const reached = await Promise.all([connection.connect(), connection.connect()]);
  assert.ok(Date.now() - at < 10_000, `found after ${Date.now() - at} ms`);
  assert.equal(reached[0].address, '127.0.0.1');
  assert.equal(reached[0], reached[1], 'two callers share one search and one connection');
  assert.equal(runnerStore.host().lastAddress, '127.0.0.1');
});

test('the runner\'s MCP process ends on its own when its client closes stdin, with the host connected', async (t) => {
  const runner = await pairedRunner(t, { serve: false });
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP'].filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-server.js'), '--runtime-config',
    path.join(runner.dataDir, 'graph-runtime.json'), '--source-application', 'codex'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => child.exitCode === null && child.kill());
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}
`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'synthetic-client', version: '1' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  for (let waited = 0; !output.includes('"id":2') && waited < 20_000; waited += 50) await delay(50);
  assert.match(output, /search_current_project_knowledge/, 'the tools came from the host');

  child.stdin.end();
  const waiting = new AbortController();
  const ended = await Promise.race([exited, delay(15_000, null, { signal: waiting.signal }).catch(() => null)]);
  waiting.abort();
  assert.notEqual(ended, null, 'the process exited after its client went away');
});

test('a host\'s MCP start (relay and server) loads none of the runner\'s MCP modules', () => {
  const loaded = [...reachableModules('src/mcp-server.js', { dynamicImports: false })].map((file) => path.resolve(file));
  for (const runnerOnly of ['src/runner/runner-mcp.js', 'src/runner/host-connection.js',
    'packages/roundtable/src/peer/nearby-discovery.js']) {
    assert.equal(loaded.includes(path.resolve(runnerOnly)), false, runnerOnly);
  }
});

test('closing a runner cuts a delivery in flight at once; the entry stays queued for the next time', async (t) => {
  const runner = await pairedRunner(t, { replayHangs: true });
  await runner.hostAway();
  await runner.client.callTool({ name: 'checkpoint_task_knowledge', arguments: { retain_nothing: true } });
  await runner.hostBack();
  await runner.client.callTool({ name: 'search_current_project_knowledge', arguments: { query: 'anything' } });
  for (let waited = 0; !runner.replayed.length && waited < 5000; waited += 20) await delay(20);
  assert.equal(runner.replayed.length, 1, 'the host holds the entry');

  const at = Date.now();
  await runner.served.close();
  // The replay wait is three minutes; well under it shows close cut it.
  assert.ok(Date.now() - at < 20_000, `closed after ${Date.now() - at} ms`);
  const store = new RunnerStore(path.join(runner.dataDir, RUNNER_FILE));
  const { queued } = store.outbox();
  store.close();
  assert.equal(queued, 1);
});

test('a checkpoint of an offline task waits only for its own delivery, at most its cap', async (t) => {
  const runner = await pairedRunner(t, { replayHangs: true, checkpointWaitMs: 300 });
  await runner.hostAway();
  const entry = await runner.client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: runner.projectPath, taskPrompt: 'offline' } });
  await runner.hostBack();
  const at = Date.now();
  const checkpoint = await runner.client.callTool({ name: 'checkpoint_task_knowledge',
    arguments: { taskContextToken: entry.structuredContent.taskContextToken, retain_nothing: true } });
  // Generous for a loaded machine; the delivery itself never ends here (the host holds it).
  assert.ok(Date.now() - at < 20_000, `answered after ${Date.now() - at} ms`);
  assert.equal(checkpoint.structuredContent.status, 'queued_offline', 'not delivered, so not said to be saved');
});

test('a runner the host revoked, whose session the host closed, says so instead of answering from what it kept', async (t) => {
  const runner = await pairedRunner(t);
  const search = { name: 'search_current_project_knowledge', arguments: { query: 'deploy steps' } };
  assert.equal((await runner.client.callTool(search)).isError, undefined);
  const [paired] = runner.store.runners();
  runner.store.revoke(paired.fingerprint);
  await runner.routes.keepRunners([]);

  const answer = await runner.client.callTool(search);
  assert.equal(answer.isError, true);
  assert.equal(JSON.parse(answer.content[0].text).code, 'runner_revoked');
  assert.ok(runner.served.store.host().revokedAt);
});
