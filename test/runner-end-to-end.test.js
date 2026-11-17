import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { resolveCallerProjectPath } from '../src/graphiti/caller-workspace.js';
import { createHostConnection } from '../src/runner/host-connection.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { joinHost } from '../src/runner/join.js';
import { deliverOutbox } from '../src/runner/outbox-delivery.js';
import { encodeInvitation, newInvitationCode, RUNNER_PATHS } from '../src/runner/protocol.js';
import { runRunnerMcp } from '../src/runner/runner-mcp.js';
import { runnerRuntimeConfig } from '../src/runner/runner-mode.js';
import { RunnerStore } from '../src/runner/runner-store.js';

const CODEX_THREAD = '0b5f3c2e-6d4a-4f8e-9a1b-2c3d4e5f6a7b';
const PROJECTS = [{ project_id: 'widgets', profile: { sources: [{ kind: 'repository', uri: 'https://example.test/team/widgets' }] } }];

// The host's MCP server, reduced to the two calls a runner's task makes. It
// resolves folders through the caller workspace exactly as task entry does.
function hostTools(calls) {
  return (_app, { sourceApplication, hostSessionId, withRuntimeLease }) => {
    const server = new Server({ name: 'fuli', version: 'test' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
      { name: 'get_collaboration_preferences', inputSchema: { type: 'object' } },
      { name: 'checkpoint_task_knowledge', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, (request) => withRuntimeLease('test', () => {
      const { name, arguments: input } = request.params;
      calls.push({ name, input, sourceApplication, hostSessionId });
      const value = name === 'get_collaboration_preferences'
        ? { resolution: resolveCallerProjectPath(input.projectPath, PROJECTS), effective_preferences: ['short answers'],
          taskContextToken: 'host-token-1' }
        : { status: 'recorded' };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    }));
    return server;
  };
}

async function identity() {
  return deviceIdentity(await createDeviceCertificate());
}

function checkout(t) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-e2e-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'my-clone');
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = git@example.test:team/widgets.git\n');
  return { base, root };
}

test('a runner pairs once, works through its host, and delivers what it queued while the host was away', async (t) => {
  const host = await identity();
  const { base, root } = checkout(t);
  const dataDir = path.join(base, 'runner-data');
  const calls = [];
  const replayed = [];
  const store = new RunnerHostStore(':memory:');
  const routes = createRunnerRoutes({ app: {}, store, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation(), createMcp: hostTools(calls),
    runTool: async (_app, toolName, input, context) => {
      replayed.push({ toolName, input, context,
        resolution: input.projectPath ? resolveCallerProjectPath(input.projectPath, PROJECTS) : null });
      return toolName === 'begin_task_context' ? { taskContextToken: 'host-token-2' } : { status: 'recorded' };
    } });
  const listen = (port) => startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port, route: routes.handle,
    sourceAllowed: () => true });
  let listener = await listen(0);
  const port = listener.port;
  t.after(async () => { await listener.close(); await routes.close(); });

  const code = newInvitationCode();
  store.invite({ code, name: 'Runner B' });
  const invitation = encodeInvitation({ name: 'Host A', addresses: ['127.0.0.1'], port, certPem: host.certPem, code });
  const joined = await joinHost({ dataDir, invitation, name: 'Office laptop' });
  const runner = joined.runner;
  assert.equal(joined.host.name, 'Host A');
  assert.equal(store.isPaired(runner.fingerprint), true);
  // Listed under the name the person typed at the invitation, with the device's own beside it.
  assert.deepEqual([store.runners()[0].name, store.runners()[0].deviceName], ['Runner B', 'Office laptop']);
  assert.equal(runnerRuntimeConfig(['--runtime-config', path.join(dataDir, 'graph-runtime.json')]), true);
  await assert.rejects(joinHost({ dataDir: path.join(base, 'other'), invitation }),
    /did not accept this invitation/);

  const client = new Client({ name: 'codex', version: 'test' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = await runRunnerMcp({ dataDir, sourceApplication: 'codex', env: { CODEX_THREAD_ID: CODEX_THREAD },
    transport: serverSide, lookUp: async () => [], retryAfterMs: 0 });
  await client.connect(clientSide);
  t.after(() => client.close());
  const { store: runnerStore, connection } = served;

  const entry = await client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: root, taskPrompt: 'tidy the order flow' } });
  assert.deepEqual(entry.structuredContent.resolution, { status: 'matched', basis: 'git_remote', personalProjectId: 'widgets' });
  assert.equal(calls[0].sourceApplication, 'codex');
  assert.equal(calls[0].hostSessionId, CODEX_THREAD, 'the host sees the Codex conversation a local client would name');

  await listener.close();
  const offline = await client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: root, taskPrompt: 'and the cart' } });
  assert.equal(offline.structuredContent.runner.offline, true);
  assert.deepEqual(offline.structuredContent.effective_preferences, ['short answers']);
  const offlineToken = offline.structuredContent.taskContextToken;
  assert.match(offlineToken, /^runner-offline-/);
  const queued = await client.callTool({ name: 'checkpoint_task_knowledge',
    arguments: { taskContextToken: offlineToken, retain_nothing: true } });
  assert.equal(queued.structuredContent.status, 'queued_offline');
  assert.equal(runnerStore.outbox().queued, 1);

  listener = await listen(port);
  const delivered = await deliverOutbox({ store: runnerStore, connection });
  assert.equal(delivered.delivered, 1);
  assert.equal(delivered.queued, 0);
  assert.deepEqual(replayed.map(({ toolName }) => toolName), ['begin_task_context', 'checkpoint_task_knowledge']);
  assert.equal(replayed[0].resolution.personalProjectId, 'widgets');
  assert.doesNotMatch(replayed[0].input.taskPrompt, /cart/);
  assert.equal(replayed[1].input.taskContextToken, 'host-token-2');
  assert.equal(replayed[0].context.hostSessionId, replayed[1].context.hostSessionId);

  const again = await connection.postJson(RUNNER_PATHS.replay, { id: queued.structuredContent.outboxId,
    tool: 'checkpoint_task_knowledge', input: { taskContextToken: offlineToken }, sourceApplication: 'codex' });
  assert.equal(again.body.replayedBefore, true);
  assert.equal(replayed.length, 2);

  store.revoke(runner.fingerprint);
  const refused = await connection.postJson(RUNNER_PATHS.workspace, { facts: null });
  assert.equal(refused.status, 403);
  // Revoked: the runner says so and answers nothing from what it kept.
  assert.equal(refused.revoked, true);
  assert.ok(runnerStore.host().revokedAt);
  const afterRevoke = await client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: root, taskPrompt: 'one more' } });
  assert.equal(JSON.parse(afterRevoke.content[0].text).code, 'runner_revoked');
});

test('a device without an invitation reaches nothing on the host', async (t) => {
  const [host, stranger] = await Promise.all([identity(), identity()]);
  const store = new RunnerHostStore(':memory:');
  const routes = createRunnerRoutes({ app: {}, store, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation() });
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, route: routes.handle,
    sourceAllowed: () => true });
  t.after(async () => { await listener.close(); await routes.close(); });
  const strangerStore = new RunnerStore(':memory:');
  strangerStore.saveHost({ name: 'Host A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port,
    addresses: ['127.0.0.1'] });
  const connection = createHostConnection({ store: strangerStore, identity: stranger, lookUp: async () => [] });

  assert.equal(await connection.connect(), null);
  const forged = deviceIdentity(await createDeviceCertificate());
  strangerStore.saveHost({ name: 'Host A', fingerprint: forged.fingerprint, certPem: forged.certPem, port: listener.port,
    addresses: ['127.0.0.1'] });
  assert.equal(await createHostConnection({ store: strangerStore, identity: stranger, lookUp: async () => [] }).connect(), null,
    'a host answering with another certificate is not the paired host');
});
