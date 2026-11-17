import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema,
  ToolListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { listAgentTools } from '../agent-tools.js';
import { nativeSessionFromEnv } from '../agents/native-session-env.js';
import { describeWorkspace } from '../graphiti/workspace-facts.js';
import { MCP_CHAT_INSTRUCTIONS, MCP_INSTRUCTIONS } from '../mcp/instructions.js';
import { mcpHostSessionId } from '../mcp/session-id.js';
import { toolNamesForProfile } from '../mcp/tool-profiles.js';
import { FULI_VERSION } from '../package-metadata.js';
import { createHostConnection } from './host-connection.js';
import { deliveredAnswer, effectiveCall, isOfflineToken, offlineAnswer, QUEUED_TOOLS, rememberAnswer,
  withoutOfflineToken } from './offline-calls.js';
import { deliverOutbox } from './outbox-delivery.js';
import { RUNNER_ENTRY_META, RUNNER_PATHS, RUNNER_SESSION_HEADER, SOURCE_APPLICATION_HEADER, TOOL_PROFILE_HEADER } from './protocol.js';
import { RUNNER_FILE, RunnerStore } from './runner-store.js';

// FULI's MCP server on a runner (docs/runner.md): the same stdio entry a client
// starts on any computer, serving through the host. Calls go to the host's
// runner listener as they are, after the folders they name were described to
// it; while the host is away they are answered by offline-calls.js. The outbox
// is delivered whenever the host answers again. The client's own session id
// travels with the session, so the host sees the same session a local client
// would name. A client gives its MCP server a few seconds to list its tools:
// when the host has not answered within TOOLS_WAIT_MS the list it last gave
// (or this version's) is the answer, and the client is told to list again
// once the host's differs.
const RETRY_AFTER_MS = 10_000;
const TOOLS_WAIT_MS = 4000;
const DELIVER_EVERY_MS = 30_000;
const DESCRIBED_FOR_MS = 60_000;
// Roundtable asks wait up to 15 minutes on the host.
const CALL_TIMEOUT_MS = 16 * 60_000;
const TOOLS_KEY = 'tools:list';

// lookUp, retryAfterMs and toolsWaitMs: how the host is looked for, how soon
// after it was away, and how long a tools/list waits for it. Without a
// transport it serves stdio and closes when stdin ends or on SIGINT/SIGTERM,
// so no socket, timer or open store outlives the client.
export async function runRunnerMcp({ dataDir, sourceApplication = 'other', toolProfile = 'chat', env = process.env,
  transport, lookUp, retryAfterMs, toolsWaitMs }) {
  const store = new RunnerStore(join(dataDir, RUNNER_FILE));
  const identity = await loadDeviceIdentity(join(dataDir, 'peer'));
  const connection = createHostConnection({ store, identity, ...(lookUp ? { lookUp } : {}) });
  const sessionId = nativeSessionFromEnv(sourceApplication, env) ?? mcpHostSessionId({});
  const server = createRunnerServer({ store, connection, sourceApplication, sessionId, toolProfile,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }), ...(toolsWaitMs === undefined ? {} : { toolsWaitMs }) });
  const stdio = !transport;
  let closing = null;
  const close = () => closing ??= (async () => {
    if (stdio) for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, close);
    // First: a delivery in flight is cut at once (its entry stays queued) instead of holding the process.
    connection.close();
    await server.close();
    store.close();
  })();
  const served = transport ?? new StdioServerTransport();
  served.onclose = () => void close();
  if (stdio) {
    process.stdin.once('end', close);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, close);
  }
  await server.connect(served);
  return { close, store, connection };
}

function createRunnerServer({ store, connection, sourceApplication, sessionId, toolProfile = 'chat',
  describe = describeWorkspace, retryAfterMs = RETRY_AFTER_MS, toolsWaitMs = TOOLS_WAIT_MS, now = Date.now }) {
  const server = new Server({ name: 'fuli', version: FULI_VERSION }, {
    capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
    instructions: toolProfile === 'chat' ? MCP_CHAT_INSTRUCTIONS : MCP_INSTRUCTIONS });
  const described = new Map();
  let client = null;
  let connecting = null;
  let unreachableUntil = 0;
  let delivering = null;
  let closed = false;

  // Concurrent calls share one connection attempt, so one MCP client is ever open.
  function upstream() {
    if (closed) return Promise.resolve(null);
    if (client) return Promise.resolve(client);
    if (now() < unreachableUntil) return Promise.resolve(null);
    connecting ??= openUpstream().finally(() => { connecting = null; });
    return connecting;
  }

  async function openUpstream() {
    const host = await connection.connect();
    if (!host || closed) return offline();
    const created = new Client({ name: 'fuli-runner', version: FULI_VERSION });
    created.setNotificationHandler(ToolListChangedNotificationSchema, () => void server.sendToolListChanged().catch(() => {}));
    const http = new StreamableHTTPClientTransport(new URL(`${host.origin}${RUNNER_PATHS.mcp}`), { fetch: host.fetch,
      requestInit: { headers: { [SOURCE_APPLICATION_HEADER]: sourceApplication, [RUNNER_SESSION_HEADER]: sessionId,
        [TOOL_PROFILE_HEADER]: toolProfile } } });
    try {
      await created.connect(http);
    } catch {
      await created.close().catch(() => {});
      return offline();
    }
    if (closed) {
      await created.close().catch(() => {});
      return null;
    }
    created.onclose = () => { if (client === created) client = null; };
    client = created;
    described.clear();
    return client;
  }

  function offline() {
    client?.close().catch(() => {});
    client = null;
    connection.drop();
    unreachableUntil = now() + retryAfterMs;
    return null;
  }

  // work(client) with the host, or null when it is away. An answer the host
  // gave, an error included, is the host's; a failed request is not.
  async function withHost(work) {
    const host = await upstream();
    if (!host) return null;
    try {
      return await work(host);
    } catch (error) {
      // Only a closed connection or a request the host never answered means it is away.
      if (error instanceof McpError && ![ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout].includes(error.code)) throw error;
      return offline();
    }
  }

  // The facts of each folder a call names, read here; a folder that is not one is the caller's error.
  async function folderFacts(paths) {
    const facts = [];
    for (const projectPath of paths) {
      if ((described.get(projectPath) ?? 0) > now() - DESCRIBED_FOR_MS) continue;
      facts.push(await describe(projectPath));
    }
    return facts;
  }

  async function sendFolders(facts) {
    for (const folder of facts) {
      const sent = await connection.postJson(RUNNER_PATHS.workspace, { facts: folder });
      if (!sent.reachable || sent.status !== 204) throw new Error('The host did not take the folder');
      described.set(folder.requestedPath, now());
    }
  }

  function deliverSoon() {
    delivering ??= deliverOutbox({ store, connection }).catch(() => {}).finally(() => { delivering = null; });
    return delivering;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listing = withHost((host) => host.listTools()).then((listed) => {
      if (listed && !closed) store.rememberAnswer(TOOLS_KEY, 'tools/list', listed);
      return listed;
    });
    const waited = new AbortController();
    const listed = await Promise.race([listing,
      delay(toolsWaitMs, null, { signal: waited.signal, ref: false }).catch(() => null)]);
    waited.abort();
    if (listed) return listed;
    const known = store.answer(TOOLS_KEY)?.body ?? { tools: localTools(toolProfile) };
    // The host answered after the client was given the known list: it lists again when they differ.
    void listing.then((late) => {
      if (late && !closed && JSON.stringify(late) !== JSON.stringify(known)) return server.sendToolListChanged();
    }).catch(() => {});
    return known;
  });

  // A checkpoint of a task entered offline is queued behind what waits
  // already; when the host answers it is delivered at once, and only a
  // delivered checkpoint is answered as saved.
  async function checkpointOffline(call) {
    const queued = offlineAnswer(store, { ...call, sourceApplication, sessionId });
    if (queued.isError || !await upstream()) return queued;
    await deliverSoon();
    const { outboxId } = queued.structuredContent;
    const outbox = store.outbox();
    return outbox.queued || outbox.failed.some((entry) => entry.id === outboxId) ? queued : deliveredAnswer(outboxId);
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const asked = effectiveCall(name, args);
    const offlineTask = isOfflineToken(asked.input.taskContextToken);
    if (offlineTask && QUEUED_TOOLS.has(asked.tool)) return checkpointOffline(asked);
    // The host does not know a runner's offline token: other calls go without it.
    const sent = offlineTask ? withoutOfflineToken(name, args) : args;
    const call = effectiveCall(name, sent);
    let facts;
    try {
      facts = await folderFacts([sent.projectPath, sent.input?.projectPath].filter((value) => typeof value === 'string'));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'invalid_input', message: error.message }) }] };
    }
    // A checkpoint carries an id online too: when its outcome is unknown it is queued under that
    // same id, and the host applies the id once whichever delivery reaches it first.
    const entryId = QUEUED_TOOLS.has(call.tool) ? randomUUID() : null;
    const answer = await withHost(async (host) => {
      await sendFolders(facts);
      return host.callTool({ name, arguments: sent, ...(entryId ? { _meta: { [RUNNER_ENTRY_META]: entryId } } : {}) },
        undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    });
    if (!answer) return offlineAnswer(store, { ...call, sourceApplication, sessionId, entryId });
    rememberAnswer(store, call, answer);
    if (store.outbox().queued) void deliverSoon();
    return answer;
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () =>
    (await withHost((host) => host.listPrompts())) ?? { prompts: [] });
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = await withHost((host) => host.getPrompt(request.params));
    if (!prompt) throw new McpError(-32603, 'Your FULI host is unreachable from this runner');
    return prompt;
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () =>
    (await withHost((host) => host.listResources())) ?? { resources: [] });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () =>
    (await withHost((host) => host.listResourceTemplates())) ?? { resourceTemplates: [] });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = await withHost((host) => host.readResource(request.params));
    if (!resource) throw new McpError(-32603, 'Your FULI host is unreachable from this runner');
    return resource;
  });

  const timer = setInterval(() => { if (store.outbox().queued) void deliverSoon(); }, DELIVER_EVERY_MS);
  timer.unref?.();
  const close = server.close.bind(server);
  // A connection still being opened closes itself once it sees closed.
  server.close = async () => {
    closed = true;
    clearInterval(timer);
    await delivering;
    await client?.close().catch(() => {});
    client = null;
    await close();
  };
  return server;
}

// The tools this version would list, for a runner that never reached its host yet.
function localTools(toolProfile) {
  const names = toolNamesForProfile(toolProfile);
  return listAgentTools().filter((tool) => !names || names.includes(tool.name))
    .map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }));
}
