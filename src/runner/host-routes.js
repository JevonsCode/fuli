import { callAgentTool } from '../agent-tools.js';
import { lifecycleHookClient, runLifecycleEvent } from '../agents/lifecycle-events.js';
import { nativeSessionEnv } from '../agents/native-session-env.js';
import { runAsRunnerCall } from '../app/agent-request-context.js';
import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { mapHttpError } from '../http/error-mapping.js';
import { readJson, sendJson } from '../http/response.js';
import { createFailedBearerLimit } from '../guest-access/failed-bearer-limit.js';
import { runWithCallerWorkspaces } from '../graphiti/caller-workspace.js';
import { parseWorkspaceFacts } from '../graphiti/workspace-facts.js';
import { createMcpServer } from '../mcp/create-mcp-server.js';
import { prepareDirectAgentToolCall } from '../mcp/direct-call.js';
import { createHttpSessionTransport } from '../mcp/http-session-transport.js';
import { mcpHostSessionId, normalizeMcpSourceApplication } from '../mcp/session-id.js';
import { FULI_VERSION } from '../package-metadata.js';
import { relayToConsole } from './console-relay.js';
import { displayName, ENTRY_ID, NATIVE_SESSION_HEADER, RUNNER_ENTRY_META, RUNNER_PATHS, RUNNER_SESSION_HEADER,
  SOURCE_APPLICATION_HEADER, TOOL_PROFILE_HEADER } from './protocol.js';

// What a runner reaches on its host (docs/runner.md), after the listener
// checked the source and read the device fingerprint. Pairing alone accepts an
// unpaired device, with a live invitation's code; every other route needs a
// paired, unrevoked runner. Its MCP sessions get the whole chat tool set, as a
// local client's do, but every call runs as that runner's: it wakes the
// person's Agents only read-only with FULI's MCP server, names no folder of
// this computer and makes no console change (runAsRunnerCall). For the length
// of each call the folders it names are answered from the facts that runner
// sent (caller-workspace.js). A checkpoint carrying an entry id, online or
// replayed from the outbox, is applied once per runner and id; a second
// delivery waits while it is applied (409) and gets the first answer after.
const MCP_MAX_SESSIONS = 32;
const MCP_SESSIONS_PER_RUNNER = 16;
const MCP_SESSION_IDLE_MS = 30 * 60 * 1000;
const MCP_SWEEP_MS = 60 * 1000;
const MCP_SHUTDOWN_GRACE_MS = 2000;
// The folders one runner described recently; the oldest is forgotten first.
const FOLDERS_PER_RUNNER = 64;
// How often a runner's last-seen time is written.
const SEEN_EVERY_MS = 60 * 1000;
// The only tool a runner queues while its host is away.
const REPLAYABLE_TOOLS = new Set(['checkpoint_task_knowledge']);
// A task a runner entered while its host was away is entered again here at
// replay. The request itself never left the runner and is not stored.
const OFFLINE_TASK_PROMPT = 'A task done on a runner while its FULI host was away; the request is not stored.';
const SESSION_ID = ENTRY_ID;
// A forwarded prompt hook gets what a client's hook process would: the clients wait 30 s.
const HOOK_TIMEOUT_MS = 25_000;
// The owner name an MCP session gives a checkpoint call (create-mcp-server.js invoke).
const ONLINE_CHECKPOINT = 'mcp-tool:checkpoint_task_knowledge';

// consoleOrigin(): the host console's own loopback origin, or null before it listens.
// runtimeConfigPath: this host's graph runtime configuration, which a forwarded prompt hook runs with.
export function createRunnerRoutes({ app, store, hostName, hostFingerprint, withLease, onPaired = () => {},
  consoleOrigin = () => null, runtimeConfigPath = null, runHook = runLifecycleEvent, createMcp = createMcpServer, runTool = runAgentTool, now = Date.now }) {
  const failedPairs = createFailedBearerLimit({ now });
  const folders = new Map();
  const lastSeen = new Map();
  const sessions = createHttpSessionTransport({ label: 'Runner MCP', maxSessions: MCP_MAX_SESSIONS,
    maxSessionsPerOwner: MCP_SESSIONS_PER_RUNNER, sessionIdleTtlMs: MCP_SESSION_IDLE_MS,
    sessionSweepIntervalMs: MCP_SWEEP_MS, now });

  const lookup = (fingerprint) => (projectPath) => folders.get(fingerprint)?.get(projectPath) ?? null;
  // Every call of a runner runs as that runner's (agent-request-context.js), with the folders it described.
  // An online checkpoint that carries its entry id is applied once per id, as its replay would be.
  const inWorkspace = (fingerprint) => (owner, operation, context) => {
    const work = () => runAsRunnerCall(fingerprint,
      () => runWithCallerWorkspaces(lookup(fingerprint), () => withLease(owner, operation, context)));
    const id = owner === ONLINE_CHECKPOINT ? context?._meta?.[RUNNER_ENTRY_META] : undefined;
    if (id === undefined) return work();
    if (typeof id !== 'string' || !ENTRY_ID.test(id)) throw new InvalidInputError(`_meta.${RUNNER_ENTRY_META} must be an entry id`);
    return once(fingerprint, id, 'checkpoint_task_knowledge', work).then(({ result }) => result);
  };

  // Applies one entry id of a runner once: a second delivery while it is being
  // applied is told to wait (409), one after gets the first answer.
  async function once(fingerprint, id, tool, apply) {
    const claim = store.claimReplay({ runner: fingerprint, id, tool });
    if (claim.state === 'done') return { result: claim.result, replayedBefore: true };
    if (claim.state === 'pending') {
      throw new ApplicationError('replay_pending', 'The host is still applying this entry; deliver it again later.', { status: 409 });
    }
    let result;
    try {
      result = await apply();
    } catch (error) {
      store.releaseReplay({ runner: fingerprint, id });
      throw error;
    }
    store.finishReplay({ runner: fingerprint, id, result });
    return { result, replayedBefore: false };
  }

  async function handle(request, response, { fingerprint, pathname, address }) {
    if (pathname === RUNNER_PATHS.pair) return pair(request, response, { fingerprint, address });
    const consolePath = pathname === RUNNER_PATHS.console || pathname.startsWith(`${RUNNER_PATHS.console}/`);
    if (!consolePath && !Object.values(RUNNER_PATHS).includes(pathname)) return false;
    if (!store.isPaired(fingerprint)) {
      sendJson(response, 403, { error: 'runner_unknown' });
      return true;
    }
    if ((lastSeen.get(fingerprint) ?? 0) < now() - SEEN_EVERY_MS) {
      lastSeen.set(fingerprint, now());
      store.seen(fingerprint, address);
    }
    try {
      await route(request, response, { fingerprint, pathname });
    } catch (error) {
      const mapped = mapHttpError(error);
      if (!response.headersSent) sendJson(response, mapped.status, mapped.body);
    }
    return true;
  }

  async function route(request, response, { fingerprint, pathname }) {
    if (pathname === RUNNER_PATHS.console || pathname.startsWith(`${RUNNER_PATHS.console}/`)) {
      relayToConsole(request, response, { consoleOrigin: consoleOrigin(), prefix: RUNNER_PATHS.console, fingerprint });
    } else if (pathname === RUNNER_PATHS.hook) {
      if (request.method !== 'POST') return void methodNotAllowed(response);
      const answer = await promptHook(fingerprint, await readJson(request));
      sendJson(response, answer.status, answer.body);
    } else if (pathname === RUNNER_PATHS.hello) {
      sendJson(response, 200, { name: hostName, fingerprint: hostFingerprint, version: FULI_VERSION });
    } else if (pathname === RUNNER_PATHS.workspace) {
      if (request.method !== 'POST') return void methodNotAllowed(response);
      rememberFolder(fingerprint, parseWorkspaceFacts((await readJson(request))?.facts));
      response.writeHead(204).end();
    } else if (pathname === RUNNER_PATHS.mcp) {
      const sourceApplication = normalizeMcpSourceApplication(request.headers[SOURCE_APPLICATION_HEADER] ?? 'other');
      const sessionId = runnerSession(request.headers[RUNNER_SESSION_HEADER]);
      const toolProfile = request.headers[TOOL_PROFILE_HEADER] === 'full' ? 'full' : 'chat';
      // The console's own environment names no session or setting of the runner's client. A session the
      // runner read from its client's environment is the client's own, as on the client's computer.
      const env = request.headers[NATIVE_SESSION_HEADER] === '1' ? nativeSessionEnv(sourceApplication, sessionId) : {};
      await sessions.handle(request, response, { owner: fingerprint, createMcp: () => createMcp(app, {
        sourceApplication, hostSessionId: sessionId, toolProfile, flaMenu: true, env,
        withRuntimeLease: inWorkspace(fingerprint) }) });
    } else if (pathname === RUNNER_PATHS.replay) {
      if (request.method !== 'POST') return void methodNotAllowed(response);
      const answer = await replay(fingerprint, await readJson(request));
      sendJson(response, answer.status, answer.body);
    }
  }

  // A runner client's prompt hook (hook-forwarding.js), entered here as the console enters a local
  // hook's: for the client's own session, in the folder the runner described, without its transcript.
  async function promptHook(fingerprint, body) {
    const client = lifecycleHookClient(body?.client);
    if (!client || body.event !== 'UserPromptSubmit' || !runtimeConfigPath || !body.payload
      || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
      return { status: 400, body: { error: 'hook_invalid' } };
    }
    rememberFolder(fingerprint, parseWorkspaceFacts(body.facts));
    const { transcript_path: _absent, ...payload } = body.payload;
    const env = Object.fromEntries(client.envNames.filter((name) => typeof body.env?.[name] === 'string')
      .map((name) => [name, body.env[name]]));
    const result = await runAsRunnerCall(fingerprint, () => runWithCallerWorkspaces(lookup(fingerprint), () => runHook({
      client: body.client, argv: ['--fuli-lifecycle', '--runtime-config', runtimeConfigPath, '--event', 'UserPromptSubmit'],
      env, cwd: process.cwd(), stdin: [Buffer.from(JSON.stringify(payload))], timeoutMs: HOOK_TIMEOUT_MS },
    { baseEnv: process.env })));
    return { status: 200, body: { stdout: String(result.stdout ?? ''), exitCode: result.exitCode ?? 0 } };
  }

  async function pair(request, response, { fingerprint, address }) {
    if (request.method !== 'POST') return methodNotAllowed(response);
    if (failedPairs.blocked(address)) {
      sendJson(response, 429, { error: 'too_many_attempts' });
      return true;
    }
    const body = await readJson(request);
    const runner = typeof body?.code === 'string'
      ? store.pair({ code: body.code, fingerprint, deviceName: displayName(body.name, '') }) : null;
    if (!runner) {
      failedPairs.fail(address);
      sendJson(response, 403, { error: 'invitation_invalid' });
      return true;
    }
    onPaired(runner);
    sendJson(response, 200, { name: hostName, fingerprint: hostFingerprint, runner });
    return true;
  }

  function rememberFolder(fingerprint, facts) {
    const known = folders.get(fingerprint) ?? new Map();
    known.delete(facts.requestedPath);
    known.set(facts.requestedPath, facts);
    while (known.size > FOLDERS_PER_RUNNER) known.delete(known.keys().next().value);
    folders.set(fingerprint, known);
  }

  // One outbox entry: { id, tool, input, sourceApplication, sessionId, offlineTask: { projectPath } | null }.
  async function replay(fingerprint, entry) {
    if (typeof entry?.id !== 'string' || !ENTRY_ID.test(entry.id) || !REPLAYABLE_TOOLS.has(entry.tool)
      || !entry.input || typeof entry.input !== 'object') {
      return { status: 400, body: { error: 'entry_invalid' } };
    }
    const sourceApplication = normalizeMcpSourceApplication(entry.sourceApplication ?? 'other');
    // Both calls of one replay belong to one session, so the entered task's token holds for its checkpoint.
    const hostSessionId = runnerSession(entry.sessionId) ?? mcpHostSessionId({});
    const run = (toolName, input) => inWorkspace(fingerprint)(`runner-replay:${toolName}`,
      () => runTool(app, toolName, input, { sourceApplication, hostSessionId }));
    try {
      const outcome = await once(fingerprint, entry.id, entry.tool, async () => {
        let input = entry.input;
        if (entry.offlineTask) {
          const entered = await run('begin_task_context', { sessionId: hostSessionId,
            projectPath: entry.offlineTask.projectPath, taskPrompt: OFFLINE_TASK_PROMPT });
          input = { ...input, taskContextToken: entered.taskContextToken ?? entered.task_context_token };
        }
        return run(entry.tool, input);
      });
      return { status: 200, body: outcome.replayedBefore ? outcome : { result: outcome.result } };
    } catch (error) {
      const mapped = mapHttpError(error);
      // A refusal the entry cannot outlive is the runner's to record; anything else is tried again.
      return { status: mapped.status, body: { error: mapped.body?.code ?? 'replay_failed',
        message: mapped.body?.error ?? 'The host could not apply the entry' } };
    }
  }

  return {
    handle,
    // A revoked runner's sessions end at once, not at their idle timeout.
    keepRunners: (fingerprints) => sessions.closeOwnersExcept(new Set(fingerprints)),
    close: () => sessions.close(Date.now() + MCP_SHUTDOWN_GRACE_MS)
  };
}

// One tool call outside an MCP session, validated and attributed as the MCP server does.
async function runAgentTool(app, toolName, input, { sourceApplication, hostSessionId }) {
  const prepared = await prepareDirectAgentToolCall({ toolName, input, sourceApplication, hostSessionId, env: {} });
  return callAgentTool(app, toolName, prepared.input, prepared.requestContext);
}

// The client session a runner's process serves (its client's own session id,
// or the one that process made), as a local client's MCP process names it.
function runnerSession(value) {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : null;
}

function methodNotAllowed(response) {
  sendJson(response, 405, { error: 'method_not_allowed' });
  return true;
}
