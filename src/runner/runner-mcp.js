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
import { fuliUnavailableGuidance } from '../local-runtime/unavailable-guidance.js';
import { openRoutes } from './call-routes.js';
import { createHostConnection } from './host-connection.js';
import { deliveredAnswer, effectiveCall, envelope, failure, hostAnsweredNote, hostOnlyAnswer, hostRefusedAnswer, isOfflineToken,
  offlineAnswer, offlineTaskAnswer, outcomeUnknownAnswer, QUEUED_TOOLS,
  isTaskEntry, rememberAnswer, repeatable, resultValue, unpairedAnswer, withoutOfflineToken } from './offline-calls.js';
import { deliverOutbox } from './outbox-delivery.js';
import { keepWholeEntry } from './entry-whole-read.js';
import { KEEP_PROJECT_TOOL, withFollowerTools } from './follower-tools.js';
import { requestSyncSoon } from './global-copy-state.js';
import { createGlobalWritesOutbox, heldBecause, hostTakesGlobalWrites } from './global-writes-outbox.js';
import { localAnswer } from './local-answer-note.js';
import { hostQuestions, makeProjectLocal, openingRefusal } from './make-project-local.js';
import { FORWARDED_TO_OWNER, forwardToOwner, refusedAsCopy } from './owner-forwarding.js';
import { queueOwnerRecruitments, recruitmentState } from './owner-recruitments.js';
import { callDestination, rememberTaskOwner, routesUnavailableAnswer } from './routed-calls.js';
import { GLOBAL_SCOPE } from './routes-store.js';
import { answerWithIssuer, ownIssuer, withIssuedToken } from './task-issuer.js';
import { CALL_TIMEOUT_MS, GLOBAL_WRITES_ENTRY, NATIVE_SESSION_HEADER, RUNNER_ENTRY_META, RUNNER_PATHS, RUNNER_SESSION_HEADER,
  SOURCE_APPLICATION_HEADER, TOOL_PROFILE_HEADER } from './protocol.js';
import { ASSESS_ON_RUNNER, ASSESS_TOOL, OUTCOME_TOOL, OUTCOME_TOOL_DEFINITION, routingRoleState } from './routing-setup.js';
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
// How long a judgment here waits for its project's whole preferences still
// being read (runnerRouting), and how long one page of that read may take.
const PREFERENCE_WAIT_MS = 30_000;
const PREFERENCE_PAGE_MS = 30_000;
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
// long a checkpoint of an offline task waits for its own delivery. endSessionMs:
// how long closing waits for the host to end this process's session. modelFetch:
// the fetch of this runner's own Tonborg model (local-routing.js). Without a
// transport it serves stdio and closes when stdin ends or on SIGINT/SIGTERM,
// so no socket, timer or open store outlives the client.
// localScope(options): this computer's own half for the scopes it owns,
// replaced in tests; by default local-scope-server.js, loaded at the first such call.
export async function runRunnerMcp({ dataDir, sourceApplication = 'other', toolProfile = 'chat', env = process.env,
  transport, lookUp, retryAfterMs, toolsWaitMs, checkpointWaitMs, endSessionMs, modelFetch, preferenceWaitMs, localScope }) {
  const store = new RunnerStore(join(dataDir, RUNNER_FILE));
  // Which scopes this computer reads and writes on the host; a data directory
  // paired by an earlier version gets `global → host` and `default → host` here.
  // A routes store this version cannot open (newer, damaged, waiting for a
  // migration) does not stop the server: every call says why and what to do.
  let routes = null;
  let routesProblem = null;
  try { routes = openRoutes(dataDir); } catch (error) { routesProblem = error; }
  const identity = await loadDeviceIdentity(join(dataDir, 'peer'));
  const connection = createHostConnection({ store, identity, ...(lookUp ? { lookUp } : {}) });
  const nativeSession = nativeSessionFromEnv(sourceApplication, env);
  const sessionId = nativeSession ?? mcpHostSessionId({});
  // What the host refused or failed when this process opened its session, for `fuli diagnostics` here.
  const record = diagnosticEventLog(dataDir).record;
  const routing = runnerRouting({ dataDir, store, fetchImpl: modelFetch, record,
    ...(preferenceWaitMs === undefined ? {} : { waitMs: preferenceWaitMs }) });
  const { server, endHostSession } = createRunnerServer({ dataDir, store, routes, routesProblem, connection, routing, record,
    sourceApplication, sessionId, nativeSession: Boolean(nativeSession), toolProfile, ...(localScope ? { localScope } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }), ...(toolsWaitMs === undefined ? {} : { toolsWaitMs }),
    ...(checkpointWaitMs === undefined ? {} : { checkpointWaitMs }), ...(endSessionMs === undefined ? {} : { endSessionMs }) });
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
    routes?.close();
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

function createRunnerServer({ dataDir, store, routes = null, routesProblem = null, connection, routing, record = () => false, sourceApplication, sessionId, nativeSession = false, toolProfile = 'chat',
  describe = describeWorkspace, retryAfterMs = RETRY_AFTER_MS, toolsWaitMs = TOOLS_WAIT_MS,
  checkpointWaitMs = CHECKPOINT_WAIT_MS, endSessionMs = END_SESSION_MS, now = Date.now,
  localScope = async (options) => (await import('./local-scope-server.js')).createLocalScopeServer(options) }) {
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
  // The start of this computer's own fingerprint: a task token naming it was given out by its own half.
  const ownName = ownIssuer(dataDir);
  // This computer's own half for the projects it owns (local-scope-server.js),
  // opened at the first call of one; its writes to global go to the host
  // through the outbox (global-writes-outbox.js).
  let localHalf = null;
  const globalWrites = createGlobalWritesOutbox({ store, sourceApplication, sessionId, waitForDelivery: async (id) => {
    const host = await connection.connect();
    afterHello();
    if (!host || !hostTakesGlobalWrites(host)) return;
    void deliverSoon();
    await whileQueued(id, checkpointWaitMs);
  } });
  const ownHalf = () => localHalf ??= Promise.resolve(localScope({ dataDir, sourceApplication, toolProfile, sessionId, globalWrites }))
    .catch((error) => {
      localHalf = null;
      throw error;
    });
  const here = { application: async () => (await ownHalf()).application(), call: async (name, args) => (await ownHalf()).call(name, args) };

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
    afterHello();
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
    if (client) await retire(clientTransport, endSessionMs);
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
    // Writes to global the host applied leave the copy here out of date: the console syncs it next (global-copy-state.js).
    delivering ??= deliverOutbox({ store, connection, onWritesApplied: () => requestSyncSoon(dataDir) })
      .catch(() => {}).finally(() => { delivering = null; });
    return delivering;
  }

  // Writes to global held here (global-writes-outbox.js requeueHeldWrites) are
  // given another round at each new hello of a host that applies them, so one
  // held for an older host, or for a host that kept failing, is sent by itself
  // once the host is updated or answers again: delivered now, not left until
  // something else happens to be queued.
  let greetedHost = null;
  function afterHello() {
    const host = connection.current;
    if (!host || host === greetedHost) return;
    greetedHost = host;
    if (hostTakesGlobalWrites(host) && store.entries().some((entry) => heldBecause(entry.reason))) void deliverSoon();
  }

  // Waits while this entry is queued, at most withinMs; the round goes on without it.
  async function whileQueued(id, withinMs) {
    const deadline = now() + withinMs;
    while (!closed && store.entryState(id) === 'queued' && now() < deadline) {
      await delay(ENTRY_POLL_MS, null, { signal: stopping.signal, ref: false }).catch(() => {});
    }
  }

  // The host's tools, with the ones this computer answers beside them (follower-tools.js).
  function withRunnerTools(listed) {
    return withFollowerTools(listed, { own: routing.listing(), keepProject: keepProjectListed() });
  }

  // Whether a new project could be made this computer's now (make-project-local.js).
  function keepProjectListed() {
    if (!routes) return false;
    try {
      return openingRefusal({ dataDir, routes, store, hostWritesGlobal: hostTakesGlobalWrites(connection.current) }) === null;
    } catch { return false; }
  }

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
    await whileQueued(outboxId, checkpointWaitMs);
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
      // Judging here still needs the pairing: the decision and its outcome are
      // the host's to keep. Checked before the model is called, so an unpaired
      // or revoked computer spends nothing and queues nothing for a host that
      // would not take it.
      const unpaired = unpairedAnswer(store);
      if (unpaired) return unpaired;
      // A task token names a task of the host's or of this runner's; a judgment here needs none.
      const { taskContextToken: _token, ...input } = asked.input;
      const answer = await routing.call(asked.tool, input, { sourceApplication, sessionId });
      if (!answer.isError) void deliverSoon();
      return answer;
    }
    if (asked.tool === KEEP_PROJECT_TOOL) return keepProjectHere(asked.input);
    // Where this call goes (docs/runner-roles-design.md §4), decided before anything is sent.
    if (routesProblem) return routesUnavailableAnswer(routesProblem);
    const destination = routes ? callDestination({ routes, store, input: asked.input, issuer, ownIssuer: ownName }) : null;
    if (destination?.refused) return destination.refused;
    // A project this computer owns, or a task it entered: its own half answers, with the token as the client holds it.
    if (destination?.to === 'local') return answerHere(name, request.params.arguments ?? {}, asked);
    const offlineTask = isOfflineToken(asked.input.taskContextToken);
    if (offlineTask && QUEUED_TOOLS.has(asked.tool)) return checkpointOffline(asked);
    // A call that cannot go without a task token (resume_agent_conversation) needs a task the host
    // entered; sent without this computer's offline token the host would only say the token is missing.
    if (offlineTask && needsHostTask(asked.tool)) {
      const host = await upstream();
      if (host && !(host instanceof HostRefusal)) return offlineTaskAnswer(asked.tool);
      // The rest of an offline task's entry, from what this computer kept (offline-calls.js).
      if (!host && asked.tool === 'read_task_preferences') return offlineAnswer(store, { ...asked, sourceApplication, sessionId });
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
    // Both read the host's own answer, before its token is given its issuer below.
    if (routes) rememberTaskOwner({ routes, store, tool: call.tool, answer });
    routing.completeEntry(call.tool, answer, readHostPreferences);
    if (store.outbox().queued) void deliverSoon();
    // Task entry says where it was answered, so the client's AI never takes a
    // follower for a computer without a FULI (rec#144).
    const noted = hostAnsweredNote(call.tool, answer, { hostName: store.host()?.name ?? 'its FULI host' });
    // The client sees the host's token only with the host's name on it: in a task entry, and in any
    // answer that repeats the token a call was made under (read_task_preferences, resume_agent_conversation).
    const hostFingerprint = store.host()?.fingerprint;
    if (isTaskEntry(call.tool)) return answerWithIssuer(noted, hostFingerprint);
    const madeUnder = call.input?.taskContextToken;
    return typeof madeUnder === 'string' && madeUnder && !isOfflineToken(madeUnder)
      ? answerWithIssuer(noted, hostFingerprint, madeUnder) : noted;
  });

  // read_task_preferences on the host, in this process's session (its reader
  // binds the session that entered the task): by name where this profile lists
  // it, else through fuli_call as the chat profile has it. Its answer's value;
  // an absent or refusing host, or an error answer, throws.
  async function readHostPreferences(input) {
    const answer = await readOnHost('read_task_preferences', input, PREFERENCE_PAGE_MS);
    if (!answer || answer instanceof HostRefusal || answer === OUTCOME_UNKNOWN) {
      throw Object.assign(new Error('The host did not answer for this task\'s preferences'), { code: 'host_unreachable' });
    }
    if (answer.isError) {
      // The host's own code, which says whether reading again from the start may help (preference_cursor_invalid).
      const said = resultValue(answer);
      const code = said?.error?.code ?? said?.code ?? 'read_refused';
      throw Object.assign(new Error(`The host refused this task's preferences (${code})`), { code });
    }
    return resultValue(answer);
  }

  // A read-only tool on the host, in this process's session: by name where this
  // profile lists it, else through fuli_call as the chat profile has it.
  function readOnHost(tool, input, timeout) {
    return withHost((host) => host.callTool(toolProfile === 'chat'
      ? { name: 'fuli_call', arguments: { toolName: tool, input } }
      : { name: tool, arguments: input }, undefined, { timeout }));
  }

  // One call of a project this computer owns, answered by its own half (local-scope-server.js).
  async function answerHere(name, args, call) {
    let answer;
    try {
      answer = await here.call(name, args);
    } catch (error) {
      // What an AI is told everywhere FULI does not answer it (unavailable-guidance.js), for this computer's own.
      return failure('local_unavailable', 'This project is on this computer, and its FULI could not answer: '
        + `${String(error?.message ?? error).slice(0, 300)}. ${fuliUnavailableGuidance(dataDir)
          || 'Start FULI here (FULI.app, or `fuli start`) and try again.'}\n`
        + '这个项目在这台电脑上，但这台电脑的 FULI 没能回答。');
    }
    const hostName = store.host()?.name ?? 'your FULI host';
    // A record of global this computer holds only as the host's copy: the host's to change.
    if (refusedAsCopy(answer) && Object.hasOwn(FORWARDED_TO_OWNER, call.tool)) {
      return forwardToOwner({ tool: call.tool, name, args, hostName, sendToHost: forwardedToHost });
    }
    let recruitment = null;
    if (isTaskEntry(call.tool) && !answer.isError) {
      rememberTaskOwner({ routes, store, tool: call.tool, answer, local: true });
      // Entered without an FLA: a lead this project recruited waits for the host to make it (owner-recruitments.js).
      const context = resultValue(answer)?.context;
      if (!context?.project_agent_id) recruitment = await recruitmentsForHost(context?.personal_project_id ?? null);
    }
    const noted = localAnswer(call.tool, answer, { hostName, recruitment, hostOnline: Boolean(connection.current),
      syncedAt: routes.all().find((row) => row.scope === GLOBAL_SCOPE)?.replicaSyncedAt ?? null, ...writesWaiting() });
    // The client sees this computer's token with this computer's name on it, as a host's with the host's.
    if (isTaskEntry(call.tool)) return answerWithIssuer(noted, ownName);
    // call carries the token without its issuer (withIssuedToken): the one this computer's half wrote.
    const madeUnder = call.input?.taskContextToken;
    return typeof madeUnder === 'string' && madeUnder && !isOfflineToken(madeUnder)
      ? answerWithIssuer(noted, ownName, madeUnder) : noted;
  }

  // The recruitments this computer's projects wait on the host for, queued once each and sent now;
  // where those of this entry's project stand.
  async function recruitmentsForHost(projectId) {
    try {
      const { waiting } = await queueOwnerRecruitments({ app: await here.application(), store, sourceApplication, sessionId });
      if (store.outbox().queued) void deliverSoon();
      return recruitmentState(store, waiting.filter((one) => projectId && one.personalProjectId === projectId)
        .map(({ id }) => id));
    } catch (error) {
      record({ component: 'mcp', operation: 'runner.owner_recruitments', outcome: 'failed',
        reason: String(error?.message ?? error).slice(0, 200) });
      return null;
    }
  }

  // How many writes to global wait here for the host, and why some are held here, if they are
  // (the host too old to take them, or failing on its side: global-writes-outbox.js heldBecause).
  function writesWaiting() {
    const waiting = store.entries().filter((entry) => entry.tool === GLOBAL_WRITES_ENTRY
      && (entry.state === 'queued' || heldBecause(entry.reason)));
    return { queuedForHost: waiting.length, held: waiting.map((entry) => heldBecause(entry.reason)).find(Boolean) ?? null };
  }

  // A change of the host's record handed to it once (owner-forwarding.js): its answer, or null while it is away.
  async function forwardedToHost(sendName, sendArgs) {
    const call = effectiveCall(sendName, sendArgs);
    const answer = await withHost((host) => host.callTool({ name: sendName, arguments: sendArgs }, undefined,
      { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true }), { repeat: false });
    if (answer === OUTCOME_UNKNOWN) return outcomeUnknownAnswer(call.tool);
    if (answer instanceof HostRefusal) return hostRefusedAnswer(answer.status, answer.reason);
    return answer;
  }

  // keep_project_on_this_computer (follower-tools.js): asked by the person through their AI.
  async function keepProjectHere(input) {
    const unpaired = unpairedAnswer(store);
    if (unpaired) return unpaired;
    if (!routes) return routesUnavailableAnswer(routesProblem);
    // This computer's half lists this process's profile: a tool the chat profile does not name goes through fuli_call.
    const local = { application: () => here.application(), call: (tool, args) => (toolProfile === 'chat'
      ? here.call('fuli_call', { toolName: tool, input: args }) : here.call(tool, args)) };
    const kept = await makeProjectLocal({ dataDir, routes, store, folder: input.projectPath ?? null,
      projectId: input.projectId ?? null, name: input.name ?? null, local, ...hostQuestions(connection) });
    if (kept.refused) return failure(kept.refused.code, kept.refused.message);
    return envelope({ ...kept, message: `${kept.scope} is now this computer's: its work is answered here.\n`
      + `${kept.scope} 现在在这台电脑上，它的工作由这台电脑回答。` });
  }

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

  const timer = setInterval(() => {
    afterHello();
    if (store.outbox().queued) void deliverSoon();
  }, DELIVER_EVERY_MS);
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
    if (localHalf) await (await localHalf.catch(() => null))?.close().catch(() => {});
    await close();
  };
  // endHostSession beside the server rather than on it: the MCP SDK owns that object.
  return { server, endHostSession };
}

// Tonborg's executor judgment on this runner while the person set it up here
// (routing-setup.js): assess_agent_action is answered here, and so is the
// outcome report, which a decision made here may get even after the setup
// is gone. The judgment's modules load on the first call that needs them.
function runnerRouting({ dataDir, store, fetchImpl, record = () => false, waitMs = PREFERENCE_WAIT_MS }) {
  let local = null;
  // The whole read of a project's preferences still under way, by project: a
  // judgment waits for its own project's only, and at most waitMs.
  const reading = new Map();
  const loaded = () => local ??= import('./local-routing.js')
    .then(({ createLocalRouting }) => createLocalRouting({ dataDir, store, ...(fetchImpl ? { fetchImpl } : {}) }));
  return {
    handles: (tool) => tool === OUTCOME_TOOL || (tool === ASSESS_TOOL && routingRoleState(dataDir).state !== 'off'),
    // What this runner adds to the host's tool list, and the host descriptions
    // that do not hold here, read in one go for every tools/list.
    listing: () => (routingRoleState(dataDir).state === 'on'
      ? { tools: [OUTCOME_TOOL_DEFINITION], descriptions: { [ASSESS_TOOL]: ASSESS_ON_RUNNER } }
      : { tools: [], descriptions: {} }),
    async call(tool, input, context) {
      const routing = await loaded();
      if (tool === OUTCOME_TOOL) return routing.outcome(input, context);
      // This project's whole read of its preferences, if one is under way, is
      // what this judgment needs: waited for, but not past waitMs, after which
      // the judgment holds and says the read was still running.
      const pending = reading.get(projectKey(input?.personalSpaceId, input?.personalProjectId));
      const waited = pending ? await Promise.race([pending.then(() => true),
        delay(waitMs, false, { ref: false })]) : true;
      return routing.assess(input, { ...context, ...(waited ? {} : { preferencesStillReading: true }) });
    },
    // A task entry answered online that the host could not deliver whole: the
    // rest is read now, in this same session, once per set (entry-whole-read.js),
    // while this runner judges executors itself, and for an MCP entry
    // (preferences_revision) also so that it can be read while the host is
    // away. The answer is not held for it, and a read that fails is written to
    // this computer's diagnostics.
    completeEntry(tool, answer, read) {
      if (!isTaskEntry(tool)) return;
      const value = resultValue(answer);
      if (!value?.preferences_revision && routingRoleState(dataDir).state !== 'on') return;
      const key = projectKey(value?.context?.personal_space_id, value?.context?.personal_project_id);
      const work = keepWholeEntry(store, answer, read).then((outcome) => {
        if (outcome && !['whole', 'not_needed', 'kept'].includes(outcome)) {
          record({ component: 'mcp', operation: 'runner.preferences_read', outcome: 'incomplete', code: outcome });
        }
      }, (error) => record({ component: 'mcp', operation: 'runner.preferences_read', outcome: 'failed',
        code: error?.code ?? 'read_failed', reason: String(error?.message ?? error).slice(0, 200) }))
        .finally(() => { if (reading.get(key) === work) reading.delete(key); });
      reading.set(key, work);
    },
    async close() {
      if (local) (await local).close();
    }
  };
}

const projectKey = (space, project) => `${space ?? ''}\u0000${project ?? ''}`;

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
