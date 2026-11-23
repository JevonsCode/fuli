import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
import { diagnosticEventLog } from '../diagnostics/event-log.js';
import { openRoutes } from './call-routes.js';
import { createHostConnection } from './host-connection.js';
import { deliveredAnswer, effectiveCall, hostAnsweredNote, hostOnlyAnswer, hostRefusedAnswer, isOfflineToken, offlineAnswer,
  offlineTaskAnswer, outcomeUnknownAnswer, QUEUED_TOOLS,
  rememberAnswer, repeatable, TASK_ENTRY_TOOLS, withoutOfflineToken } from './offline-calls.js';
import { deliverOutbox } from './outbox-delivery.js';
import { routeRefusal, rememberTaskOwner } from './routed-calls.js';
import { answerWithIssuer, withIssuedToken } from './task-issuer.js';
import { CALL_TIMEOUT_MS, NATIVE_SESSION_HEADER, RUNNER_ENTRY_META, RUNNER_PATHS, RUNNER_SESSION_HEADER, SOURCE_APPLICATION_HEADER, TOOL_PROFILE_HEADER } from './protocol.js';
import { ASSESS_TOOL, OUTCOME_TOOL, OUTCOME_TOOL_DEFINITION, routingRoleState } from './routing-setup.js';
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
// How long a checkpoint of an offline task waits for its own delivery once the host answers, and how often it looks.
const CHECKPOINT_WAIT_MS = 20_000;
const ENTRY_POLL_MS = 200;
const TOOLS_KEY = 'tools:list';
// What the MCP client reports when a response stream broke and nothing will resume it.
const STREAM_LOST = /SSE stream disconnected|Failed to reconnect|Maximum reconnection attempts/;
// withHost's answer for a call that changes something whose connection dropped after it was sent.
const OUTCOME_UNKNOWN = Symbol('outcome unknown');
// How long a closing process waits for the host to end its MCP session; past it, the host's idle timeout does.
const END_SESSION_MS = 2000;
// The same for a session this process stops using to open another (a dropped stream, a lost connection).
const RETIRE_SESSION_MS = 1000;
// The host's answer to a runner it does not know: looked into through hello (revoked), never a refusal to report.
const NOT_PAIRED_STATUS = 403;

// The host answered but would not open an MCP session (its session limit, a
// failure on its side): the reason it gave, which the caller is told as it is
// instead of answers kept for an unreachable host.
class HostRefusal {
  constructor(status, message) {
    this.status = status;
    // The JSON-RPC error the host sent, when the SDK's message carries one.
    const body = String(message ?? '').match(/\{.*\}\s*$/s)?.[0];
    let reason = null;
    try { reason = body ? JSON.parse(body)?.error?.message : null; } catch { reason = null; }
    this.reason = String(reason ?? message ?? '').slice(0, 200);
  }
}

// lookUp, retryAfterMs, toolsWaitMs and checkpointWaitMs: how the host is looked
// for, how soon after it was away, how long a tools/list waits for it, and how
// long a checkpoint of an offline task waits for its own delivery. modelFetch:
// the fetch of this runner's own Tonborg model (local-routing.js). Without a
// transport it serves stdio and closes when stdin ends or on SIGINT/SIGTERM,
// so no socket, timer or open store outlives the client.
export async function runRunnerMcp({ dataDir, sourceApplication = 'other', toolProfile = 'chat', env = process.env,
  transport, lookUp, retryAfterMs, toolsWaitMs, checkpointWaitMs, modelFetch }) {
  const store = new RunnerStore(join(dataDir, RUNNER_FILE));
  // Which scopes this computer reads and writes on the host; a data directory
  // paired by an earlier version gets `global → host` and `default → host` here.
  const routes = openRoutes(dataDir);
  const identity = await loadDeviceIdentity(join(dataDir, 'peer'));
  const connection = createHostConnection({ store, identity, ...(lookUp ? { lookUp } : {}) });
  const nativeSession = nativeSessionFromEnv(sourceApplication, env);
  const sessionId = nativeSession ?? mcpHostSessionId({});
  const routing = runnerRouting({ dataDir, store, fetchImpl: modelFetch });
  // What the host refused or failed when this process opened its session, for `fuli diagnostics` here.
  const record = diagnosticEventLog(dataDir).record;
  const { server, endHostSession } = createRunnerServer({ store, routes, connection, routing, record, sourceApplication, sessionId, nativeSession: Boolean(nativeSession), toolProfile,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }), ...(toolsWaitMs === undefined ? {} : { toolsWaitMs }),
    ...(checkpointWaitMs === undefined ? {} : { checkpointWaitMs }) });
  const stdio = !transport;
  let closing = null;
  const close = () => closing ??= (async () => {
    if (stdio) for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, close);
    // First the host releases this process's MCP session (bounded), while the connection still carries it;
    // then a delivery in flight is cut at once (its entry stays queued) instead of holding the process.
    await endHostSession();
    connection.close();
    await server.close();
    await routing.close();
    routes.close();
    store.close();
  })();
  const served = transport ?? new StdioServerTransport();
  served.onclose = () => void close();
  if (stdio) {
    process.stdin.once('end', close);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, close);
  }
  await server.connect(served);
  return { close, store, routes, connection };
}

function createRunnerServer({ store, routes = null, connection, routing, record = () => false, sourceApplication, sessionId, nativeSession = false, toolProfile = 'chat',
  describe = describeWorkspace, retryAfterMs = RETRY_AFTER_MS, toolsWaitMs = TOOLS_WAIT_MS,
  checkpointWaitMs = CHECKPOINT_WAIT_MS, now = Date.now }) {
  const server = new Server({ name: 'fuli', version: FULI_VERSION }, {
    capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
    instructions: toolProfile === 'chat' ? MCP_CHAT_INSTRUCTIONS : MCP_INSTRUCTIONS });
  const described = new Map();
  let client = null;
  // The transport of client: it ends the session on the host (DELETE) when this process closes.
  let clientTransport = null;
  let connecting = null;
  let unreachableUntil = 0;
  // The code of the last session problem recorded, so a repeating one is recorded once until a session opens.
  let lastProblem = null;
  let delivering = null;
  let closed = false;
  const stopping = new AbortController();

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
        ...(nativeSession ? { [NATIVE_SESSION_HEADER]: '1' } : {}),
        [TOOL_PROFILE_HEADER]: toolProfile } } });
    try {
      await created.connect(http);
    } catch (error) {
      await created.close().catch(() => {});
      if (error instanceof StreamableHTTPError && error.code >= 400 && error.code !== NOT_PAIRED_STATUS) {
        const refusal = new HostRefusal(error.code, error.message);
        problem({ outcome: 'refused', code: 'host_refused', httpStatus: refusal.status, reason: refusal.reason });
        return refusal;
      }
      problem({ outcome: 'failed', code: 'host_session_failed', reason: String(error?.message ?? error) });
      return helloThenOffline();
    }
    lastProblem = null;
    if (closed) {
      await created.close().catch(() => {});
      return null;
    }
    // A session the host ended (revoked, restarted) is opened again through hello, not the old connection.
    created.onclose = () => {
      if (client !== created) return;
      client = null;
      connection.drop();
    };
    // A response stream that broke (the connection dropped with a call in
    // flight) leaves that call waiting for an answer that cannot come: the
    // client is closed, so the call ends as ConnectionClosed (withHost).
    created.onerror = (error) => {
      if (client !== created || !STREAM_LOST.test(String(error?.message ?? ''))) return;
      // The session is still the host's until it hears otherwise: end it before a new one is opened.
      void retire(http, RETIRE_SESSION_MS).then(() => created.close()).catch(() => {});
    };
    client = created;
    clientTransport = http;
    described.clear();
    return client;
  }

  // Ends this process's session on the host now (MCP's DELETE), so it does not
  // hold one of the host's sessions until the idle timeout. Bounded: a host
  // that does not answer releases it at that timeout instead.
  async function endHostSession() {
    if (client) await retire(clientTransport, END_SESSION_MS);
  }

  // Ends one session on the host (MCP's DELETE), waiting at most withinMs. A
  // host that already dropped it answers 404, and one that does not answer
  // releases it at its idle timeout.
  async function retire(transport, withinMs) {
    await Promise.race([transport.terminateSession().catch(() => {}), delay(withinMs, null, { ref: false })]);
  }

  // A session that could not be opened, recorded once until one opens again.
  function problem(event) {
    if (lastProblem === event.code) return;
    lastProblem = event.code;
    record({ component: 'mcp', operation: 'runner.session_open', ...event });
  }

  // The host refused or dropped the session (it may have revoked this runner
  // and closed its sessions, or only restarted): ask hello once at the known
  // addresses on a fresh connection, without mDNS. A revoked runner then says
  // so instead of answering from what it kept; true means the host answers.
  async function helloAgain() {
    // A session this process stops using is ended first, unless the host already dropped it.
    if (client) await retire(clientTransport, RETIRE_SESSION_MS);
    await client?.close().catch(() => {});
    client = null;
    connection.drop();
    return !closed && Boolean(await connection.connect({ knownOnly: true }));
  }

  async function helloThenOffline() {
    await helloAgain();
    return offline();
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
  // work(client) with the host: its answer, null when the host is away (or a
  // repeatable call's outcome is unknown, which its offline answer covers), or
  // OUTCOME_UNKNOWN when a call that changes something was sent before the
  // connection dropped. A session the host dropped while it answers hello
  // again (it restarted) is opened afresh, and a repeatable call (a read, a
  // checkpoint under its entry id) is made once more there; one that timed out
  // may still be running on the host and is not.
  async function withHost(work, { repeat = true } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const host = await upstream();
      if (!host || host instanceof HostRefusal) return host;
      try {
        return await work(host);
      } catch (error) {
        // Only a closed connection or a request the host never answered means it is away.
        if (error instanceof McpError && ![ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout].includes(error.code)) throw error;
        const timedOut = error instanceof McpError && error.code === ErrorCode.RequestTimeout;
        // A folder the host did not take: the call itself was never sent.
        const safe = repeat || error?.notSent === true;
        const answers = !timedOut && await helloAgain();
        if (safe && attempt === 0 && answers) continue;
        if (!answers) offline();
        // A revoked runner says so; anything else that was sent and changes something is unknown.
        return safe || store.host()?.revokedAt ? null : OUTCOME_UNKNOWN;
      }
    }
  }

  // The facts of each folder a call names, read here; a folder that is not one is the caller's error.
  // read: facts already read for this call, used again instead of reading the folder twice.
  async function folderFacts(paths, read = []) {
    const facts = [];
    for (const projectPath of paths) {
      if ((described.get(projectPath) ?? 0) > now() - DESCRIBED_FOR_MS) continue;
      facts.push(read.find((fact) => fact.requestedPath === projectPath) ?? await describe(projectPath));
    }
    return facts;
  }

  async function sendFolders(facts) {
    for (const folder of facts) {
      const sent = await connection.postJson(RUNNER_PATHS.workspace, { facts: folder });
      if (!sent.reachable || sent.status !== 204) throw Object.assign(new Error('The host did not take the folder'), { notSent: true });
      described.set(folder.requestedPath, now());
    }
  }

  function deliverSoon() {
    delivering ??= deliverOutbox({ store, connection }).catch(() => {}).finally(() => { delivering = null; });
    return delivering;
  }

  // The host's tools, and this runner's own while it chooses executors itself.
  const withRunnerTools = (listed) => ({ ...listed,
    tools: [...listed.tools.filter((tool) => tool.name !== OUTCOME_TOOL), ...routing.tools()] });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // A host that refused the session lists nothing; its calls then say why.
    const listing = withHost((host) => host.listTools()).then((answered) => {
      const listed = answered instanceof HostRefusal ? null : answered;
      if (listed && !closed) store.rememberAnswer(TOOLS_KEY, 'tools/list', listed);
      return listed && withRunnerTools(listed);
    });
    const waited = new AbortController();
    const listed = await Promise.race([listing,
      delay(toolsWaitMs, null, { signal: waited.signal, ref: false }).catch(() => null)]);
    waited.abort();
    if (listed) return listed;
    const known = withRunnerTools(store.answer(TOOLS_KEY)?.body ?? { tools: localTools(toolProfile) });
    // The host answered after the client was given the known list: it lists again when they differ.
    void listing.then((late) => {
      if (late && !closed && JSON.stringify(late) !== JSON.stringify(known)) return server.sendToolListChanged();
    }).catch(() => {});
    return known;
  });

  // A checkpoint of a task entered offline is queued behind what waits
  // already; when the host answers it is delivered at once, and only a
  // delivered checkpoint is answered as saved. The call waits for its own entry
  // only, at most CHECKPOINT_WAIT_MS; the round goes on without it.
  async function checkpointOffline(call) {
    const queued = offlineAnswer(store, { ...call, sourceApplication, sessionId });
    const host = await upstream();
    if (queued.isError || !host || host instanceof HostRefusal) return queued;
    const { outboxId } = queued.structuredContent;
    void deliverSoon();
    const deadline = now() + checkpointWaitMs;
    while (!closed && store.entryState(outboxId) === 'queued' && now() < deadline) {
      await delay(ENTRY_POLL_MS, null, { signal: stopping.signal, ref: false }).catch(() => {});
    }
    return !closed && store.entryState(outboxId) === null ? deliveredAnswer(outboxId) : queued;
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    // A token the host issued names it (task-issuer.js): the host gets its own token back.
    const { args, issuer } = withIssuedToken(name, request.params.arguments ?? {});
    const asked = effectiveCall(name, args);
    const refused = hostOnlyAnswer(asked.tool);
    if (refused) return refused;
    if (routing.handles(asked.tool)) {
      // A task token names a task of the host's or of this runner's; a judgment here needs none.
      const { taskContextToken: _token, ...input } = asked.input;
      const answer = await routing.call(asked.tool, input, { sourceApplication, sessionId });
      if (!answer.isError) void deliverSoon();
      return answer;
    }
    // Where this call goes (docs/runner-roles-design.md §4), decided before anything is sent.
    const misrouted = routes ? routeRefusal({ routes, store, input: asked.input, issuer }) : null;
    if (misrouted) return misrouted;
    const offlineTask = isOfflineToken(asked.input.taskContextToken);
    if (offlineTask && QUEUED_TOOLS.has(asked.tool)) return checkpointOffline(asked);
    // A call that cannot go without a task token (resume_agent_conversation) needs a task the host
    // entered; sent without this computer's offline token the host would only say the token is missing.
    if (offlineTask && needsHostTask(asked.tool)) {
      const host = await upstream();
      if (host && !(host instanceof HostRefusal)) return offlineTaskAnswer(asked.tool);
    }
    // The host does not know a runner's offline token: other calls go without it.
    const sent = offlineTask ? withoutOfflineToken(name, args) : args;
    const call = effectiveCall(name, sent);
    const paths = [sent.projectPath, sent.input?.projectPath].filter((value) => typeof value === 'string');
    let facts;
    try {
      facts = await folderFacts(paths, []);
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'invalid_input', message: error.message }) }] };
    }
    // A checkpoint carries an id online too: when its outcome is unknown it is queued under that
    // same id, and the host applies the id once whichever delivery reaches it first.
    const entryId = QUEUED_TOOLS.has(call.tool) ? randomUUID() : null;
    const answer = await withHost(async (host) => {
      // A session opened meanwhile (the host came back or restarted) has none of them yet.
      await sendFolders(await folderFacts(paths, facts));
      return host.callTool({ name, arguments: sent, ...(entryId ? { _meta: { [RUNNER_ENTRY_META]: entryId } } : {}) },
        undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    }, { repeat: repeatable(call.tool) });
    if (answer === OUTCOME_UNKNOWN) return outcomeUnknownAnswer(call.tool);
    if (answer instanceof HostRefusal) return hostRefusedAnswer(answer.status, answer.reason);
    if (!answer) return offlineAnswer(store, { ...call, sourceApplication, sessionId, entryId });
    rememberAnswer(store, call, answer);
    if (routes) rememberTaskOwner({ routes, store, tool: call.tool, answer });
    if (store.outbox().queued) void deliverSoon();
    // Task entry says where it was answered, so the client's AI never takes a
    // follower for a computer without a FULI (rec#144).
    const noted = hostAnsweredNote(call.tool, answer, { hostName: store.host()?.name ?? 'its FULI host' });
    return TASK_ENTRY_TOOLS.has(call.tool) ? answerWithIssuer(noted, store.host()?.fingerprint) : noted;
  });

  // A listing or read the host answered; a refused session lists nothing, and a read says why.
  const listed = async (work) => {
    const answer = await withHost(work);
    return answer instanceof HostRefusal ? null : answer;
  };
  const read = async (work) => {
    const answer = await withHost(work);
    if (answer instanceof HostRefusal) {
      throw new McpError(-32603, `Your FULI host refused a new MCP session (HTTP ${answer.status}: ${answer.reason})`);
    }
    if (!answer) throw new McpError(-32603, 'Your FULI host is unreachable from this runner');
    return answer;
  };
  server.setRequestHandler(ListPromptsRequestSchema, async () => (await listed((host) => host.listPrompts())) ?? { prompts: [] });
  server.setRequestHandler(GetPromptRequestSchema, (request) => read((host) => host.getPrompt(request.params)));
  server.setRequestHandler(ListResourcesRequestSchema, async () =>
    (await listed((host) => host.listResources())) ?? { resources: [] });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () =>
    (await listed((host) => host.listResourceTemplates())) ?? { resourceTemplates: [] });
  server.setRequestHandler(ReadResourceRequestSchema, (request) => read((host) => host.readResource(request.params)));

  const timer = setInterval(() => { if (store.outbox().queued) void deliverSoon(); }, DELIVER_EVERY_MS);
  timer.unref?.();
  const close = server.close.bind(server);
  // A connection still being opened closes itself once it sees closed.
  server.close = async () => {
    closed = true;
    stopping.abort();
    clearInterval(timer);
    await delivering;
    await client?.close().catch(() => {});
    client = null;
    await close();
  };
  // endHostSession beside the server rather than on it: the MCP SDK owns that object.
  return { server, endHostSession };
}

// Tonborg's executor judgment on this runner while the person set it up here
// (routing-setup.js): assess_agent_action is answered here, and so is the
// outcome report, which a decision made here may get even after the setup
// is gone. The judgment's modules load on the first call that needs them.
function runnerRouting({ dataDir, store, fetchImpl }) {
  let local = null;
  const loaded = () => local ??= import('./local-routing.js')
    .then(({ createLocalRouting }) => createLocalRouting({ dataDir, store, ...(fetchImpl ? { fetchImpl } : {}) }));
  return {
    handles: (tool) => tool === OUTCOME_TOOL || (tool === ASSESS_TOOL && routingRoleState(dataDir).state !== 'off'),
    tools: () => (routingRoleState(dataDir).state === 'on' ? [OUTCOME_TOOL_DEFINITION] : []),
    async call(tool, input, context) {
      const routing = await loaded();
      return tool === OUTCOME_TOOL ? routing.outcome(input, context) : routing.assess(input, context);
    },
    async close() {
      if (local) (await local).close();
    }
  };
}

// The tools whose schema requires the host's task token (a checkpoint is queued instead).
let hostTaskTools = null;
function needsHostTask(tool) {
  hostTaskTools ??= new Set(listAgentTools().filter((definition) => !QUEUED_TOOLS.has(definition.name)
    && definition.inputSchema?.required?.includes('taskContextToken')).map(({ name }) => name));
  return hostTaskTools.has(tool);
}

// The tools this version would list, for a runner that never reached its host yet.
function localTools(toolProfile) {
  const names = toolNamesForProfile(toolProfile);
  return listAgentTools().filter((tool) => !names || names.includes(tool.name))
    .map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }));
}
