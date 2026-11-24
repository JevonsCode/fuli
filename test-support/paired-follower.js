import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { joinHost } from '../src/runner/join.js';
import { encodeInvitation, newInvitationCode } from '../src/runner/protocol.js';
import { runRunnerMcp } from '../src/runner/runner-mcp.js';

// A follower paired with a host over a real runner listener on loopback
// (docs/runner.md). The host's MCP server is reduced: it lists hostTools and
// answers each call with hostAnswer(name, input); its application is hostApp,
// which a follower's writes to global reach (host-global-writes.js). The
// follower's own half (local-scope-server.js) is a stand-in that records each
// call and answers with localAnswer(name, args). Synthetic names only.
export const HOST_TOOLS = ['get_collaboration_preferences', 'checkpoint_task_knowledge', 'search_current_project_knowledge',
  'list_personal_projects', 'revise_personal_knowledge', 'record_knowledge_usage'];

export function jsonAnswer(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

export function errorAnswer(code, message) {
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }], structuredContent: { error: { code, message } } };
}

export async function pairedFollower(t, { hostTools = HOST_TOOLS, hostAnswer = () => ({ status: 'recorded' }), hostApp = {},
  localAnswer = () => jsonAnswer({ status: 'answered_here' }), localApp = null, checkpointWaitMs } = {}) {
  const host = deviceIdentity(await createDeviceCertificate());
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-follower-')));
  const calls = [];
  const store = new RunnerHostStore(':memory:');
  const routes = createRunnerRoutes({ app: hostApp, store, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation(),
    createMcp: () => {
      const server = new Server({ name: 'fuli', version: 'test' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: hostTools.map((name) => ({ name, inputSchema: { type: 'object' } })) }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: input } = request.params;
        calls.push({ name, input });
        const value = await hostAnswer(name, input);
        return value?.content ? value : jsonAnswer(value);
      });
      return server;
    } });
  const state = { away: false };
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: (request, response, context) => {
      if (!state.away) return routes.handle(request, response, context);
      request.socket.destroy();
      return true;
    } });
  const code = newInvitationCode();
  store.invite({ code, name: 'Follower B' });
  const dataDir = path.join(base, 'follower-data');
  await joinHost({ dataDir, invitation: encodeInvitation({ name: 'Host A', addresses: ['127.0.0.1'], port: listener.port,
    certPem: host.certPem, code }) });
  const projectPath = path.join(base, 'widgets');
  mkdirSync(projectPath);

  const local = { opened: [], calls: [], closed: 0 };
  const localScope = (options) => {
    local.opened.push(options);
    return { call: async (name, args) => {
      local.calls.push({ name, args });
      return localAnswer(name, args, options);
    }, application: async () => localApp, close: async () => { local.closed += 1; } };
  };
  const client = new Client({ name: 'codex', version: 'test' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = await runRunnerMcp({ dataDir, sourceApplication: 'codex', transport: serverSide, lookUp: async () => [],
    retryAfterMs: 0, localScope, ...(checkpointWaitMs === undefined ? {} : { checkpointWaitMs }) });
  await client.connect(clientSide);
  t.after(async () => {
    await client.close();
    await served.close();
    await listener.close();
    await routes.close();
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { client, calls, served, local, dataDir, projectPath, base, hostStore: store,
    hostAway: () => { state.away = true; }, hostBack: () => { state.away = false; } };
}
