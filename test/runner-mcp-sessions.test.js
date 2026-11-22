import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createDeviceCertificate, deviceIdentity, loadDeviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { MCP_CHAT_INSTRUCTIONS } from '../src/mcp/instructions.js';
import { createHostConnection } from '../src/runner/host-connection.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { joinHost } from '../src/runner/join.js';
import { encodeInvitation, newInvitationCode } from '../src/runner/protocol.js';
import { runRunnerMcp } from '../src/runner/runner-mcp.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';

// A runner's MCP sessions on its host (docs/runner.md, "MCP sessions on the
// host"): each MCP process ends its own session when it closes, no runner has
// a cap of its own, and a session the host refuses is said as such, never
// taken for the host being away.

test('starting and stopping many MCP processes of a runner leaves no session behind on the host', async (t) => {
  const pair = await pairedRunner(t);
  // More than the 16 sessions a runner was once held to; each one is closed before the next starts.
  for (let round = 0; round < 20; round += 1) {
    const runner = await pair.serve();
    await runner.client.listTools();
    assert.equal((await pair.sessions()).owned, 1, `round ${round}`);
    await runner.stop();
    assert.equal((await pair.sessions()).owned, 0, `round ${round}: its session was ended when it closed`);
  }
});

test('a runner may hold more sessions than one runner once could, up to the host\'s total', async (t) => {
  const pair = await pairedRunner(t);
  const open = [];
  for (let index = 0; index < 20; index += 1) {
    const runner = await pair.serve();
    await runner.client.listTools();
    open.push(runner);
  }
  assert.deepEqual(await pair.sessions(), { owned: 20, open: 20, max: 64 });
  for (const runner of open) await runner.stop();
  assert.equal((await pair.sessions()).owned, 0);
});

test('a session the host refuses is said with its reason, not answered as if the host were away', async (t) => {
  const pair = await pairedRunner(t, { maxMcpSessions: 1 });
  const first = await pair.serve();
  await first.client.listTools();
  const second = await pair.serve();

  const answer = await second.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: 'next' } });

  assert.equal(answer.isError, true);
  const refusal = JSON.parse(answer.content[0].text);
  assert.equal(refusal.code, 'host_refused');
  assert.match(refusal.message, /HTTP 503: Runner MCP session limit reached/);
  assert.doesNotMatch(answer.content[0].text, /runner-offline-/);

  // The first process closing frees its session at once, so the next call reaches the host.
  await first.stop();
  const again = await second.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: 'next' } });
  assert.equal(again.structuredContent.taskContextToken, 'host-token');
  await second.stop();
});

test('a new client on a runner resumes a conversation after many earlier clients came and went', async (t) => {
  // The host's limit is small, as a full one was on a real runner: each earlier
  // client entered a task and left; none may leave its session behind.
  const pair = await pairedRunner(t, { maxMcpSessions: 2 });
  for (let round = 0; round < 6; round += 1) {
    const earlier = await pair.serve();
    await earlier.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: `earlier ${round}` } });
    await earlier.stop();
  }

  const fresh = await pair.serve();
  const entry = await fresh.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: 'continue' } });
  assert.equal(entry.structuredContent.taskContextToken, 'host-token', 'the task was entered on the host, not offline');
  const resumed = await fresh.client.callTool({ name: 'fuli_call', arguments: { toolName: 'resume_agent_conversation',
    input: { taskContextToken: 'host-token', conversationId: 'conversation-1' } } });

  assert.equal(resumed.isError, undefined, resumed.content?.[0]?.text);
  assert.equal(resumed.structuredContent.status, 'resumed');
  assert.deepEqual(pair.calls.at(-1), { name: 'fuli_call', arguments: { toolName: 'resume_agent_conversation',
    input: { taskContextToken: 'host-token', conversationId: 'conversation-1' } } });
});

test('a connection lost in the middle of a call leaves one session on the host, not two', async (t) => {
  const pair = await pairedRunner(t, { dropFirstCall: true });
  const runner = await pair.serve();
  await runner.client.listTools();

  const entry = await runner.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: 'again' } });

  assert.equal(entry.structuredContent.taskContextToken, 'host-token', 'the call was made again on a fresh session');
  assert.equal((await pair.sessions()).owned, 1, 'the session it stopped using was ended');
  await runner.stop();
  assert.equal((await pair.sessions()).owned, 0);
});

test('a refused session is written once to the runner\'s own diagnostics', async (t) => {
  const pair = await pairedRunner(t, { maxMcpSessions: 1 });
  const first = await pair.serve();
  await first.client.listTools();
  const second = await pair.serve();
  for (let call = 0; call < 2; call += 1) {
    await second.client.callTool({ name: 'get_collaboration_preferences', arguments: { taskPrompt: 'next' } });
  }

  const events = readFileSync(path.join(pair.dataDir, 'diagnostics', 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter((event) => event.operation === 'runner.session_open');
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'host_refused');
  assert.equal(events[0].httpStatus, 503);
  assert.match(events[0].reason, /session limit reached/);
});

test('FULI tells a client\'s AI to close connections it no longer uses', () => {
  assert.match(MCP_CHAT_INSTRUCTIONS, /Close FULI connections and test scripts once unused; never reopen in a loop/);
});

// A runner paired with a real listener on loopback whose MCP side is reduced
// to task entry and fuli_call (calls: what reached it). serve() starts one of the runner's MCP processes (its client
// side and stop()); sessions() is what the host's hello says of its sessions.
// dropFirstCall: the host's first tool call loses every connection while it runs, its session left as it was.
async function pairedRunner(t, { maxMcpSessions, dropFirstCall = false } = {}) {
  const sockets = new Set();
  let dropping = dropFirstCall;
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-sessions-')));
  const host = deviceIdentity(await createDeviceCertificate());
  const store = new RunnerHostStore(':memory:');
  const calls = [];
  const routes = createRunnerRoutes({ app: {}, store, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation(), ...(maxMcpSessions ? { maxMcpSessions } : {}),
    createMcp: () => {
      const server = new Server({ name: 'fuli', version: 'test' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: ['get_collaboration_preferences', 'fuli_call'].map((name) => ({ name, inputSchema: { type: 'object' } })) }));
      server.setRequestHandler(CallToolRequestSchema, (request) => {
        calls.push({ name: request.params.name, arguments: request.params.arguments });
        if (dropping) {
          dropping = false;
          setImmediate(() => { for (const socket of sockets) socket.destroy(); });
          return new Promise(() => {});
        }
        const value = request.params.name === 'fuli_call' ? { status: 'resumed' }
          : { effective_preferences: [], taskContextToken: 'host-token' };
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      });
      return server;
    } });
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: (request, response, context) => {
      sockets.add(request.socket);
      request.socket.once('close', () => sockets.delete(request.socket));
      return routes.handle(request, response, context);
    } });
  const code = newInvitationCode();
  store.invite({ code, name: 'Runner B' });
  const dataDir = path.join(base, 'runner-data');
  await joinHost({ dataDir, invitation: encodeInvitation({ name: 'Host A', addresses: ['127.0.0.1'], port: listener.port,
    certPem: host.certPem, code }) });
  const runnerStore = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  const connection = createHostConnection({ store: runnerStore, identity: await loadDeviceIdentity(path.join(dataDir, 'peer')),
    lookUp: async () => [] });
  const running = new Set();
  // In this order, the folder last: Windows refuses to delete a SQLite file that is still open.
  t.after(async () => {
    for (const runner of running) await runner.stop();
    connection.close();
    runnerStore.close();
    await listener.close();
    await routes.close();
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  return {
    calls,
    dataDir,
    sessions: async () => (await connection.hello()).mcpSessions,
    async serve() {
      const client = new Client({ name: 'codex', version: 'test' });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const served = await runRunnerMcp({ dataDir, sourceApplication: 'codex', transport: serverSide,
        lookUp: async () => [], retryAfterMs: 0 });
      await client.connect(clientSide);
      const runner = { client, stop: async () => {
        running.delete(runner);
        await client.close();
        await served.close();
      } };
      running.add(runner);
      return runner;
    }
  };
}
