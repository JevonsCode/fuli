import { join } from 'node:path';

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
import { effectiveCall, offlineAnswer, OFFLINE_TOKEN_PREFIX, rememberAnswer } from './offline-calls.js';
import { deliverOutbox } from './outbox-delivery.js';
import { RUNNER_PATHS, RUNNER_SESSION_HEADER, SOURCE_APPLICATION_HEADER, TOOL_PROFILE_HEADER } from './protocol.js';
import { RUNNER_FILE, RunnerStore } from './runner-store.js';

// FULI's MCP server on a runner (docs/runner.md): the same stdio entry a client
// starts on any computer, serving through the host. Calls go to the host's
// runner listener as they are, after the folders they name were described to
// it; while the host is away they are answered by offline-calls.js. The outbox
// is delivered whenever the host answers again. The client's own session id
// travels with the session, so the host sees the same session a local client
// would name.
const RETRY_AFTER_MS = 10_000;
const DELIVER_EVERY_MS = 30_000;
const DESCRIBED_FOR_MS = 60_000;
// Roundtable asks wait up to 15 minutes on the host.
const CALL_TIMEOUT_MS = 16 * 60_000;
const TOOLS_KEY = 'tools:list';

// lookUp and retryAfterMs: how the host is looked for, and how soon after it was away.
export async function runRunnerMcp({ dataDir, sourceApplication = 'other', toolProfile = 'chat', env = process.env,
  transport = new StdioServerTransport(), lookUp, retryAfterMs }) {
  const store = new RunnerStore(join(dataDir, RUNNER_FILE));
  const identity = await loadDeviceIdentity(join(dataDir, 'peer'));
  const connection = createHostConnection({ store, identity, ...(lookUp ? { lookUp } : {}) });
  const sessionId = nativeSessionFromEnv(sourceApplication, env) ?? mcpHostSessionId({});
  const server = createRunnerServer({ store, connection, sourceApplication, sessionId, toolProfile,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  const close = async () => {
    await server.close();
    connection.close();
    store.close();
  };
  transport.onclose = () => void close();
  await server.connect(transport);
  return { close, store, connection };
}

function createRunnerServer({ store, connection, sourceApplication, sessionId, toolProfile = 'chat',
  describe = describeWorkspace, retryAfterMs = RETRY_AFTER_MS, now = Date.now }) {
  const server = new Server({ name: 'fuli', version: FULI_VERSION }, {
    capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
    instructions: toolProfile === 'chat' ? MCP_CHAT_INSTRUCTIONS : MCP_INSTRUCTIONS });
  const described = new Map();
  let client = null;
  let unreachableUntil = 0;
  let delivering = null;

  async function upstream() {
    if (client) return client;
    if (now() < unreachableUntil) return null;
    const host = await connection.connect();
    if (!host) return offline();
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
    const listed = await withHost((host) => host.listTools());
    if (listed) {
      store.rememberAnswer(TOOLS_KEY, 'tools/list', listed);
      return listed;
    }
    return store.answer(TOOLS_KEY)?.body ?? { tools: localTools(toolProfile) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const call = effectiveCall(name, args);
    const offlineToken = typeof call.input.taskContextToken === 'string'
      && call.input.taskContextToken.startsWith(OFFLINE_TOKEN_PREFIX);
    let facts;
    try {
      facts = await folderFacts([args.projectPath, args.input?.projectPath].filter((value) => typeof value === 'string'));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'invalid_input', message: error.message }) }] };
    }
    const answer = offlineToken ? null : await withHost(async (host) => {
      await sendFolders(facts);
      return host.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    });
    if (!answer) {
      const queued = offlineAnswer(store, { ...call, sourceApplication, sessionId });
      // A task entered offline whose host is back: its checkpoint goes now, behind what was queued first.
      if (offlineToken && client) void deliverSoon();
      return queued;
    }
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
  server.close = async () => {
    clearInterval(timer);
    await delivering;
    await client?.close().catch(() => {});
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
