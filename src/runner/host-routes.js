import { callAgentTool } from '../agent-tools.js';
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
import { displayName, RUNNER_PATHS, RUNNER_SESSION_HEADER, SOURCE_APPLICATION_HEADER, TOOL_PROFILE_HEADER } from './protocol.js';

// What a runner reaches on its host (docs/runner.md), after the listener
// checked the source and read the device fingerprint. Pairing alone accepts an
// unpaired device, with a live invitation's code; every other route needs a
// paired, unrevoked runner. Its MCP sessions get the whole chat tool set, as a
// local client's do; for the length of each call the folders it names are
// answered from the facts that runner sent (caller-workspace.js). An outbox
// entry is replayed once per id; a second delivery gets the first answer.
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
const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function createRunnerRoutes({ app, store, hostName, hostFingerprint, withLease, onPaired = () => {},
  createMcp = createMcpServer, runTool = runAgentTool, now = Date.now }) {
  const failedPairs = createFailedBearerLimit({ now });
  const folders = new Map();
  const lastSeen = new Map();
  const sessions = createHttpSessionTransport({ label: 'Runner MCP', maxSessions: MCP_MAX_SESSIONS,
    maxSessionsPerOwner: MCP_SESSIONS_PER_RUNNER, sessionIdleTtlMs: MCP_SESSION_IDLE_MS,
    sessionSweepIntervalMs: MCP_SWEEP_MS, now });

  const lookup = (fingerprint) => (projectPath) => folders.get(fingerprint)?.get(projectPath) ?? null;
  const inWorkspace = (fingerprint) => (owner, operation, context) =>
    runWithCallerWorkspaces(lookup(fingerprint), () => withLease(owner, operation, context));

  async function handle(request, response, { fingerprint, pathname, address }) {
    if (pathname === RUNNER_PATHS.pair) return pair(request, response, { fingerprint, address });
    if (!Object.values(RUNNER_PATHS).includes(pathname)) return false;
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
    if (pathname === RUNNER_PATHS.hello) {
      sendJson(response, 200, { name: hostName, fingerprint: hostFingerprint, version: FULI_VERSION });
    } else if (pathname === RUNNER_PATHS.workspace) {
      if (request.method !== 'POST') return void methodNotAllowed(response);
      rememberFolder(fingerprint, parseWorkspaceFacts((await readJson(request))?.facts));
      response.writeHead(204).end();
    } else if (pathname === RUNNER_PATHS.mcp) {
      const sourceApplication = normalizeMcpSourceApplication(request.headers[SOURCE_APPLICATION_HEADER] ?? 'other');
      const sessionId = runnerSession(request.headers[RUNNER_SESSION_HEADER]);
      const toolProfile = request.headers[TOOL_PROFILE_HEADER] === 'full' ? 'full' : 'chat';
      await sessions.handle(request, response, { owner: fingerprint, createMcp: () => createMcp(app, {
        sourceApplication, hostSessionId: sessionId, toolProfile, flaMenu: true,
        withRuntimeLease: inWorkspace(fingerprint) }) });
    } else if (pathname === RUNNER_PATHS.replay) {
      if (request.method !== 'POST') return void methodNotAllowed(response);
      const answer = await replay(fingerprint, await readJson(request));
      sendJson(response, answer.status, answer.body);
    }
  }

  async function pair(request, response, { fingerprint, address }) {
    if (request.method !== 'POST') return methodNotAllowed(response);
    if (failedPairs.blocked(address)) {
      sendJson(response, 429, { error: 'too_many_attempts' });
      return true;
    }
    const body = await readJson(request);
    const runner = typeof body?.code === 'string'
      ? store.pair({ code: body.code, fingerprint, name: displayName(body.name, '') }) : null;
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
    if (typeof entry?.id !== 'string' || !SESSION_ID.test(entry.id) || !REPLAYABLE_TOOLS.has(entry.tool)
      || !entry.input || typeof entry.input !== 'object') {
      return { status: 400, body: { error: 'entry_invalid' } };
    }
    const earlier = store.replayed(entry.id);
    if (earlier) return { status: 200, body: { ...earlier, replayedBefore: true } };
    const sourceApplication = normalizeMcpSourceApplication(entry.sourceApplication ?? 'other');
    // Both calls of one replay belong to one session, so the entered task's token holds for its checkpoint.
    const hostSessionId = runnerSession(entry.sessionId) ?? mcpHostSessionId({});
    const run = (toolName, input) => inWorkspace(fingerprint)(`runner-replay:${toolName}`,
      () => runTool(app, toolName, input, { sourceApplication, hostSessionId }));
    try {
      let input = entry.input;
      if (entry.offlineTask) {
        const entered = await run('begin_task_context', { sessionId: hostSessionId,
          projectPath: entry.offlineTask.projectPath, taskPrompt: OFFLINE_TASK_PROMPT });
        input = { ...input, taskContextToken: entered.taskContextToken ?? entered.task_context_token };
      }
      const outcome = { result: await run(entry.tool, input) };
      store.recordReplay({ id: entry.id, runner: fingerprint, tool: entry.tool, result: outcome });
      return { status: 200, body: outcome };
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
