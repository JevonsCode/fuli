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
import { hostOwner } from '../src/runner/routes-store.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';
import { reachableModules } from '../test-support/module-graph.js';

// A runner's MCP server while its host is away, slow, or back (docs/runner.md).
// The host is a real runner listener on loopback with a reduced MCP server: its
// task entry carries a receipt and a checkpoint duty, as a real entry does.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST_TOOLS = ['get_collaboration_preferences', 'checkpoint_task_knowledge', 'search_current_project_knowledge',
  'resume_agent_conversation'];

test('a paired runner refuses host diagnostic events online and offline in both MCP profiles', async (t) => {
  const runner = await pairedRunner(t);
  for (const state of ['online', 'offline']) {
    if (state === 'offline') runner.hostAway();
    for (const request of [
      { name: 'read_diagnostic_events', arguments: {} },
      { name: 'fuli_call', arguments: { toolName: 'read_diagnostic_events', input: {} } }
    ]) {
      const answer = await runner.client.callTool(request);
      assert.equal(answer.isError, true, state);
      assert.equal(JSON.parse(answer.content[0].text).code, 'local_user_only');
    }
  }
  assert.deepEqual(runner.calls, []);
});

// serve: false pairs only; the caller starts the runner's MCP server itself.
// replayHangs: the host takes an outbox entry and never answers it.
// dropFirst: tool names whose first call the host takes and then drops with the session, as a restart does.
async function pairedRunner(t, { listDelayMs = 0, toolsWaitMs, checkpointWaitMs, serve = true, replayHangs = false,
  dropFirst = [], resumeAnswer = null } = {}) {
  const drop = new Set(dropFirst);
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
        if (drop.delete(name)) {
          // The connection drops with the call in flight: every socket goes, then the sessions.
          setImmediate(() => {
            for (const socket of state.sockets) socket.destroy();
            void routes.keepRunners([]);
          });
          return new Promise(() => {});
        }
        const value = name === 'get_collaboration_preferences'
          ? { effective_preferences: ['short answers'], taskContextToken: 'host-token-1', checkpoint_required: true,
            agent_receipt: { required: true, markdown: 'earlier task receipt' } }
          : name === 'resume_agent_conversation'
            ? (resumeAnswer ?? { recovery_context: `what ${input.conversationId} last held` })
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
  const state = { away: false, sockets: new Set() };
  state.listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: (request, response, context) => {
      state.sockets.add(request.socket);
      request.socket.once('close', () => state.sockets.delete(request.socket));
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

// rec#144: the client's AI took a follower whose host was away for a computer
// without a FULI, because nothing in a task entry said where it was answered.
test('a task entry says which computer answered it, online and offline', async (t) => {
  const runner = await pairedRunner(t);
  const online = await runner.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: 'first' } });
  assert.equal(online.structuredContent.runner.offline, false);
  assert.equal(online.structuredContent.runner.host, 'Host A');
  assert.equal(online.structuredContent.agent_receipt.markdown, 'earlier task receipt', 'the host\'s own answer is kept whole');
  assert.deepEqual(JSON.parse(online.content[0].text), online.structuredContent);

  await runner.hostAway();
  const offline = await runner.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: 'second' } });
  assert.equal(offline.structuredContent.runner.offline, true);
  assert.match(offline.structuredContent.runner.message, /Host A.*FULI is working/s);
  assert.match(offline.structuredContent.runner.message, /Nothing needs to be moved or set up again/);
});

// rec#144: 「主机每天带回家、runner 留在办公室接着干」, which failed exactly when the host was away.
test('a conversation resumed while the host is away comes from this computer\'s cache, and says so', async (t) => {
  const runner = await pairedRunner(t);
  // The task is entered in this project's folder: its token is the host's.
  await runner.client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: runner.projectPath, taskPrompt: 'online' } });
  const online = await runner.client.callTool({ name: 'resume_agent_conversation',
    arguments: { taskContextToken: 'host-token-1', conversationId: 'conversation-1' } });
  assert.equal(online.structuredContent.recovery_context, 'what conversation-1 last held');

  await runner.hostAway();
  const otherFolder = path.join(path.dirname(runner.projectPath), 'other-project');
  mkdirSync(otherFolder);
  for (const [folder, workLog] of [[runner.projectPath, 'synthetic work done since'], [otherFolder, 'work of another project']]) {
    const entry = await runner.client.callTool({ name: 'get_collaboration_preferences',
      arguments: { projectPath: folder, taskPrompt: 'offline' } });
    await runner.client.callTool({ name: 'checkpoint_task_knowledge',
      arguments: { taskContextToken: entry.structuredContent.taskContextToken, workLog } });
  }

  const offline = await runner.client.callTool({ name: 'resume_agent_conversation',
    arguments: { taskContextToken: 'host-token-1', conversationId: 'conversation-1' } });
  assert.equal(offline.isError, undefined);
  assert.equal(offline.structuredContent.runner.offline, true);
  assert.ok(offline.structuredContent.runner.answeredAt, 'it says when the context it repeats was read');
  assert.equal(offline.structuredContent.recovered_from_cache, true);
  assert.equal(offline.structuredContent.undelivered_checkpoints, 1, 'it says how much it carried over');
  assert.deepEqual(offline.structuredContent.undelivered_work.map((work) => work.summary), ['synthetic work done since'],
    'work of another project is never carried in');
  assert.match(offline.structuredContent.runner.message, /cache/);
});

test('an offline resume repeats only the recovery context, never the earlier task\'s receipt or duties', async (t) => {
  const runner = await pairedRunner(t, { resumeAnswer: { latest_checkpoint: { status: 'done', summary: 'synthetic' },
    messages: [], status: 'resumed', agent_receipt: { markdown: 'earlier receipt' }, checkpoint_required: true } });
  await runner.client.callTool({ name: 'resume_agent_conversation',
    arguments: { taskContextToken: 'host-token-1', conversationId: 'conversation-1' } });
  await runner.hostAway();
  const offline = await runner.client.callTool({ name: 'resume_agent_conversation',
    arguments: { taskContextToken: 'host-token-1', conversationId: 'conversation-1' } });
  assert.equal(offline.isError, undefined, offline.content?.[0]?.text);
  assert.deepEqual(offline.structuredContent.latest_checkpoint, { status: "done", summary: "synthetic" });
  for (const field of ['agent_receipt', 'checkpoint_required', 'status']) {
    assert.equal(offline.structuredContent[field], undefined, field);
  }
});

test('a conversation resumed offline with only unrelated work waiting says there is nothing', async (t) => {
  const runner = await pairedRunner(t);
  await runner.hostAway();
  const entry = await runner.client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: runner.projectPath, taskPrompt: 'offline' } });
  await runner.client.callTool({ name: 'checkpoint_task_knowledge',
    arguments: { taskContextToken: entry.structuredContent.taskContextToken, workLog: 'unrelated' } });
  const answer = await runner.client.callTool({ name: 'resume_agent_conversation',
    arguments: { taskContextToken: 'host-token-of-a-task-never-entered-here', conversationId: 'conversation-9' } });
  assert.equal(answer.isError, true);
  assert.equal(JSON.parse(answer.content[0].text).undelivered_checkpoints, 0);
});

test('a conversation this computer never read, with nothing waiting, says so and makes nothing up', async (t) => {
  const runner = await pairedRunner(t);
  await runner.hostAway();
  const answer = await runner.client.callTool({ name: 'resume_agent_conversation',
    arguments: { taskContextToken: 'host-token-1', conversationId: 'conversation-never-read' } });
  assert.equal(answer.isError, true);
  const failure = JSON.parse(answer.content[0].text);
  assert.equal(failure.code, 'host_unreachable');
  assert.equal(failure.recovered_from_cache, false);
  assert.equal(failure.undelivered_checkpoints, 0);
  assert.match(failure.message, /Nothing is made up/);
});

// docs/runner-roles-design.md §10: a runner paired by an earlier version gets
// `global → host` and `default → host`, and behaves exactly as it did.
test('a runner of an earlier version follows its host for every scope and answers as before', async (t) => {
  const runner = await pairedRunner(t);
  assert.deepEqual(runner.served.routes.all().map((row) => row.scope), ['global', 'default']);
  const entry = await runner.client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: runner.projectPath, taskPrompt: 'routed' } });
  assert.equal(runner.calls.at(-1).name, 'get_collaboration_preferences', 'the host answered it');
  // The token names the FULI that issued it (design §4.4), and the host gets its own token back.
  const fingerprint = runner.served.store.host().fingerprint;
  assert.equal(entry.structuredContent.taskContextToken, `fuli-from-${fingerprint.slice(0, 16)}.host-token-1`);
  assert.equal(entry.structuredContent.agent_receipt.markdown, 'earlier task receipt', 'nothing else of the answer changes');
  await runner.client.callTool({ name: 'checkpoint_task_knowledge',
    arguments: { taskContextToken: entry.structuredContent.taskContextToken, workLog: 'synthetic' } });
  assert.equal(runner.calls.at(-1).input.taskContextToken, 'host-token-1');
  // A token passed as the host wrote it still goes back there; only its digest is kept here.
  assert.match(runner.served.routes.taskOwner('host-token-1'), /^host:/);
  assert.equal(runner.served.routes.db.prepare("SELECT COUNT(*) AS n FROM task_owners WHERE token_sha256 = 'host-token-1'")
    .get().n, 0, 'the token itself is not stored');

  // A token another FULI issued reaches nothing here.
  const before = runner.calls.length;
  const foreign = await runner.client.callTool({ name: 'checkpoint_task_knowledge',
    arguments: { taskContextToken: `fuli-from-${'9'.repeat(16)}.host-token-1`, workLog: 'synthetic' } });
  assert.equal(JSON.parse(foreign.content[0].text).code, 'task_owner_not_paired');
  assert.equal(runner.calls.length, before);
});

test('a scope routed to a computer this one is not paired with reaches nothing, and says where to fix it', async (t) => {
  const runner = await pairedRunner(t);
  runner.served.routes.set('global', hostOwner('f'.repeat(64)));
  const before = runner.calls.length;
  const answer = await runner.client.callTool({ name: 'search_current_project_knowledge', arguments: { query: 'synthetic' } });
  assert.equal(answer.isError, true);
  const failure = JSON.parse(answer.content[0].text);
  assert.equal(failure.code, 'scope_owner_not_paired');
  assert.match(failure.message, /fuli routes follow global/);
  assert.equal(runner.calls.length, before, 'nothing was sent to the host paired now');

  // A task entered on that other computer: its calls are not sent to this one's host either.
  runner.served.routes.set('global', hostOwner(runner.served.store.host().fingerprint));
  runner.served.routes.rememberTaskOwner('task-of-another-computer', hostOwner('f'.repeat(64)));
  const checkpoint = await runner.client.callTool({ name: 'checkpoint_task_knowledge',
    arguments: { taskContextToken: 'task-of-another-computer', workLog: 'synthetic' } });
  assert.equal(JSON.parse(checkpoint.content[0].text).code, 'task_owner_not_paired');
  assert.equal(runner.calls.length, before);
  assert.equal(runner.served.store.outbox().queued, 0, 'and nothing was queued for a host that would apply it');
});

test('a scope marked as this computer\'s, on a computer without a FULI of its own, is refused instead of sent', async (t) => {
  const runner = await pairedRunner(t);
  runner.served.routes.set('global', 'local');
  const answer = await runner.client.callTool({ name: 'search_current_project_knowledge', arguments: { query: 'synthetic' } });
  assert.equal(JSON.parse(answer.content[0].text).code, 'scope_owned_here');
  assert.equal(runner.calls.some(({ name }) => name === 'search_current_project_knowledge'), false);
});

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

test('a call that needs the host\'s task, made with an offline token once the host is back, says to enter the task again', async (t) => {
  const runner = await pairedRunner(t);
  await runner.hostAway();
  const entry = await runner.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: 'offline' } });
  const offlineToken = entry.structuredContent.taskContextToken;
  const away = await runner.client.callTool({ name: 'fuli_call', arguments: { toolName: 'resume_agent_conversation',
    input: { taskContextToken: offlineToken, conversationId: 'conversation-1' } } });
  assert.equal(JSON.parse(away.content[0].text).code, 'host_unreachable', 'while the host is away it is still away');

  await runner.hostBack();
  const back = await runner.client.callTool({ name: 'fuli_call', arguments: { toolName: 'resume_agent_conversation',
    input: { taskContextToken: offlineToken, conversationId: 'conversation-1' } } });
  const answer = JSON.parse(back.content[0].text);
  assert.equal(answer.code, 'offline_task_token');
  assert.match(answer.message, /enter the task again with get_collaboration_preferences/);
  assert.equal(runner.calls.some(({ name }) => name === 'fuli_call' || name === 'resume_agent_conversation'), false,
    'nothing went to the host without its token');
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
  // An address that takes the connection and never says a word, first in line as the last that answered:
  // the IPv6 loopback on the same port (macOS has no 127.0.0.2; every supported system has ::1).
  const held = new Set();
  const silent = createNetServer((socket) => held.add(socket));
  const bound = await new Promise((resolve) => {
    silent.once('error', () => resolve(false));
    silent.listen(listener.port, '::1', () => resolve(true));
  });
  if (!bound) {
    await listener.close();
    await routes.close();
    store.close();
    t.skip('this machine has no IPv6 loopback');
    return;
  }
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-probe-')));
  const code = newInvitationCode();
  store.invite({ code, name: 'Runner B' });
  const dataDir = path.join(base, 'runner-data');
  await joinHost({ dataDir, invitation: encodeInvitation({ name: 'Host A', addresses: ['127.0.0.1'], port: listener.port,
    certPem: host.certPem, code }) });
  const runnerStore = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  runnerStore.saveHost({ name: 'Host A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port,
    addresses: ['[::1]', '127.0.0.1'], lastAddress: '[::1]' });
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
  assert.ok(held.size > 0, 'the silent address was tried too');
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

test('a host\'s MCP start (relay and server) loads none of the runner\'s MCP modules, its routes included', () => {
  const loaded = [...reachableModules('src/mcp-server.js', { dynamicImports: false })].map((file) => path.resolve(file));
  for (const runnerOnly of ['src/runner/runner-mcp.js', 'src/runner/host-connection.js',
    'packages/roundtable/src/peer/nearby-discovery.js', 'src/runner/call-routes.js', 'src/runner/routed-calls.js']) {
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

test('a host that only restarted gets the call again on a fresh session, not an offline answer', async (t) => {
  const runner = await pairedRunner(t);
  const search = { name: 'search_current_project_knowledge', arguments: { query: 'deploy steps' } };
  await runner.client.callTool(search);
  // As a restart does: every session of this runner ends, and the host answers hello again.
  await runner.routes.keepRunners([]);

  const answer = await runner.client.callTool({ ...search, arguments: { query: 'after restart' } });

  assert.equal(answer.isError, undefined);
  assert.equal(answer.structuredContent?.runner?.offline, undefined, 'not an answer from cache');
  assert.deepEqual(runner.calls.at(-1), { name: 'search_current_project_knowledge', input: { query: 'after restart' } });
});

test('after a dropped session a read is made again on a fresh one; a call that changes something is not', async (t) => {
  const runner = await pairedRunner(t, { dropFirst: ['search_current_project_knowledge', 'message_agent'] });

  const read = await runner.client.callTool({ name: 'search_current_project_knowledge', arguments: { query: 'deploy steps' } });
  assert.equal(read.isError, undefined);
  assert.deepEqual(runner.calls.filter((call) => call.name === 'search_current_project_knowledge').length, 2, 'the read ran again');

  const write = await runner.client.callTool({ name: 'message_agent', arguments: { to: 'synthetic-agent', body: 'synthetic ask' } });
  assert.equal(write.isError, true);
  assert.equal(JSON.parse(write.content[0].text).code, 'outcome_unknown');
  assert.equal(runner.calls.filter((call) => call.name === 'message_agent').length, 1, 'the write was not repeated');
});
