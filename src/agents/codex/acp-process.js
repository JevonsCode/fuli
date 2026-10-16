import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { ApplicationError } from '../../app/application-error.js';
import { spawnWindowsJobProcess } from '../../native-runtime/windows-job-process.js';
import { createCodexAcpSession } from './acp-session.js';

const AUTH = '_auth/status_update';
const AUTH_KINDS = new Set(['none', 'account', 'api_key', 'gateway', 'external']);
const OS_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP']);
const MAX_BYTES = 64 * 1024;
const samePath = (a, b) => normalize(a).toLowerCase() === normalize(b).toLowerCase();
const failure = code => new ApplicationError(`acp_${code}`, `Codex ACP ${code.replaceAll('_', ' ')}.`);

// One owned Windows adapter/session tree. Lease and WorkerRun policy stay with the host.
// Login, trust changes, resume, and arbitrary RPC are deliberately not exposed.
export async function startCodexAcpProcess({ adapterPath, codexPath, codexHome, cwd,
  env = process.env, signal, initializeTimeoutMs = 15_000, stopTimeoutMs = 10_000 }) {
  if (process.platform !== 'win32') throw failure('platform_unsupported');
  for (const value of [initializeTimeoutMs, stopTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw failure('invalid_timeout');
  }
  const paths = await isolatedPaths({ adapterPath, codexPath, codexHome, cwd });
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => OS_ENV.has(key.toUpperCase())));
  Object.assign(childEnv, { CODEX_HOME: paths.codexHome, CODEX_PATH: paths.codexPath,
    HOME: paths.codexHome, USERPROFILE: paths.codexHome,
    APPDATA: join(paths.codexHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(paths.codexHome, 'AppData', 'Local') });
  if (signal?.aborted) throw failure('cancelled');
  const nodePath = await realpath(process.execPath);
  if (signal?.aborted) throw failure('cancelled');
  const initializeDeadline = Date.now() + initializeTimeoutMs;
  const initializeRemaining = () => {
    const value = initializeDeadline - Date.now();
    if (value <= 0) throw failure('timeout');
    return value;
  };
  const child = await spawnWindowsJobProcess(nodePath, [paths.adapterPath], { cwd: paths.cwd, env: childEnv, stopTimeoutMs });
  let connection, session, closing, initialization, notification = Promise.resolve(), authentication = 'unknown';
  let stderrBytes = 0, stderrTruncated = false, terminalError = null, timer;
  const requestedIds = new Set();
  const authenticationWaiters = new Set();
  const owned = new Set(), permissions = [];
  const lifetime = new AbortController();
  let resolveClosed, rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void closed.catch(() => {});
  async function waitForAuthentication({ timeoutMs = 5000, signal: callerSignal } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw failure('invalid_timeout');
    let timeout, observed, stopped, cancelled;
    try {
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      if (callerSignal?.aborted) throw failure('cancelled');
      const observedAuthentication = await new Promise((resolve, reject) => {
        // An initialize ACK can precede the first wire-validated auth notification.
        observed = () => resolve(authentication);
        stopped = () => reject(lifetime.signal.reason ?? failure('closed'));
        cancelled = () => reject(failure('cancelled'));
        authenticationWaiters.add(observed);
        lifetime.signal.addEventListener('abort', stopped, { once: true });
        callerSignal?.addEventListener('abort', cancelled, { once: true });
        timeout = setTimeout(() => reject(failure('authentication_timeout')), timeoutMs);
        if (authentication !== 'unknown') observed();
        if (lifetime.signal.aborted) stopped();
        if (callerSignal?.aborted) cancelled();
      });
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      if (callerSignal?.aborted) throw failure('cancelled');
      return observedAuthentication;
    } catch (error) {
      const reason = lifetime.signal.reason ?? error;
      await close(reason);
      throw reason;
    } finally {
      clearTimeout(timeout);
      authenticationWaiters.delete(observed);
      if (stopped) lifetime.signal.removeEventListener('abort', stopped);
      if (cancelled) callerSignal?.removeEventListener('abort', cancelled);
    }
  }
  async function capture() {
    const pids = await child.snapshot();
    for (const pid of pids) if (owned.size < 64) owned.add(pid);
    return pids.includes(child.pid);
  }
  function close(reason = failure('closed')) {
    if (closing) return closing;
    terminalError ??= reason;
    clearTimeout(timer);
    closing = Promise.resolve().then(async () => {
      signal?.removeEventListener('abort', cancelled);
      const deadline = Date.now() + stopTimeoutMs;
      const remaining = () => {
        const value = deadline - Date.now();
        if (value <= 0) throw failure('cleanup_incomplete');
        return value;
      };
      try {
        // SDK close aborts its write queue. Give session/cancel a bounded chance
        // to flush first, without letting a blocked adapter delay job cleanup.
        await boundedExit(notification.catch(() => {}), Math.min(1500, remaining()));
        connection?.close(reason);
        child.stdin.end();
        // Allow a queued session/cancel and stdin EOF to reach the adapter.
        // The job retains every descendant throughout this bounded grace period.
        if (child.pid) await boundedExit(child.exited, Math.min(1500, remaining()));
        await child.stop(remaining());
        resolveClosed();
      } catch {
        connection?.close(failure('cleanup_incomplete'));
        child.stdin.end();
        child.unref(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        const error = failure('cleanup_incomplete'); error.cleanupIncomplete = true;
        rejectClosed(error); throw error;
      }
    });
    lifetime.abort(terminalError);
    return closing;
  }
  const cancelled = () => {
    terminalError ??= failure('cancelled');
    void (session ? session.cancel() : close(terminalError)).catch(() => {});
  };
  try {
    void child.exited.then(() => { void close(terminalError ?? failure('closed')).catch(() => {}); });
    child.stderr.on('data', chunk => {
      stderrTruncated ||= stderrBytes + chunk.length > MAX_BYTES;
      stderrBytes = Math.min(MAX_BYTES, stderrBytes + chunk.length);
    });
    child.stdin.on('error', () => { void close(failure('closed')).catch(() => {}); });
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    if (closing) throw terminalError;
    timer = setTimeout(() => { terminalError ??= failure('timeout'); void close(terminalError).catch(() => {}); }, initializeRemaining());
    await Promise.race([child.ready, closed.then(() => { throw terminalError ?? failure('closed'); })]);
    if (!await capture()) throw failure('closed');
    if (closing) throw terminalError ?? failure('closed');
    const output = Writable.toWeb(child.stdin), writer = output.getWriter();
    const trackedOutput = new WritableStream({ write(chunk) {
      const message = JSON.parse(new TextDecoder().decode(chunk));
      if (Object.hasOwn(message, 'id') && message.method) requestedIds.add(message.id);
      return writer.write(chunk);
    } });
    const filtered = Readable.toWeb(child.stdout).pipeThrough(initializationWireGuard(message => {
      if (message?.jsonrpc !== '2.0' || Array.isArray(message)) throw failure('protocol_error');
      if (message.method === AUTH && !Object.hasOwn(message, 'id')) {
        const kind = message.params?.authStatus?.kind;
        if (!AUTH_KINDS.has(kind)) throw failure('protocol_error');
        return { jsonrpc: '2.0', method: AUTH, params: { kind } };
      }
      if (message.method === methods.client.session.requestPermission &&
          (Number.isSafeInteger(message.id) || (typeof message.id === 'string' && message.id.length <= 128))) return message;
      if (message.method === methods.client.session.update && !Object.hasOwn(message, 'id')) return session.projectUpdate(message.params);
      if (Object.hasOwn(message, 'method') || !requestedIds.delete(message.id)) throw failure('protocol_error');
      return message;
    }, error => { terminalError ??= error; }));
    connection = client().onNotification(AUTH, value => value, ({ params }) => {
      authentication = params.kind;
      for (const observed of authenticationWaiters) observed();
    })
      .onRequest(methods.client.session.requestPermission, ({ params, requestId }) => {
        if (permissions.length < 16) permissions.push({ requestId, sessionId: params.sessionId.slice(0, 128),
          toolCallId: params.toolCall.toolCallId.slice(0, 128), optionKinds: params.options.slice(0, 16).map(option => option.kind) });
        return { outcome: { outcome: 'cancelled' } };
      }).connect(ndJsonStream(trackedOutput, filtered));
    session = createCodexAcpSession({ cwd: paths.cwd, codexHome: paths.codexHome, close, signal: lifetime.signal,
      notify: (method, params) => { notification = connection.agent.notify(method, params); return notification; },
      request: async (method, params) => {
        if (closing) throw terminalError;
        const response = await connection.agent.request(method, params);
        if (closing) throw terminalError;
        if (method === methods.agent.session.new || method === methods.agent.session.prompt) await capture();
        return response;
      } });
    void connection.closed.then(() => { void close(terminalError ?? failure('closed')).catch(() => {}); });
    const response = await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {}, clientInfo: { name: 'fuli', version: '1' } }, { cancellationSignal: signal });
    if (response.protocolVersion !== PROTOCOL_VERSION) throw failure('handshake_failed');
    initialization = { protocolVersion: response.protocolVersion, agentVersion: response.agentInfo?.version ?? null };
    if (!await capture()) throw failure('closed');
    if (closing) throw terminalError ?? failure('closed');
    return { pid: child.pid, initialization, signal: lifetime.signal, closed, close, waitForAuthentication,
      newSession: session.newSession, configureModel: session.configureModel, promptOnce: session.promptOnce, cancel: session.cancel,
      get ownedPids() { return [...owned]; }, get authentication() { return authentication; },
      get pendingPermissions() { return structuredClone(permissions); },
      get diagnostics() { return { stderrBytes, stderrTruncated }; } };
  } catch (error) {
    const safe = terminalError ?? (error instanceof ApplicationError ? error : failure('handshake_failed'));
    await close(safe);
    throw safe;
  } finally { clearTimeout(timer); }
}

// Only tracked responses and the bounded auth/permission/session contract reach the SDK.
// No generic RPC dispatcher or response schema replaces the SDK's own parser.
function initializationWireGuard(project, rejected) {
  let pending = '';
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  function line(value, controller) {
    if (!value.trim()) return;
    let message;
    try { message = JSON.parse(value); } catch { throw failure('protocol_error'); }
    if (!message || typeof message !== 'object') throw failure('protocol_error');
    try {
      const projected = project(message);
      if (projected !== null) controller.enqueue(encoder.encode(JSON.stringify(projected) + '\n'));
    } catch (error) { rejected(error); throw error; }
  }
  return new TransformStream({ transform(chunk, controller) {
    pending += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(pending) > 256 * 1024) throw failure('protocol_error');
    let boundary;
    while ((boundary = pending.indexOf('\n')) !== -1) {
      line(pending.slice(0, boundary), controller); pending = pending.slice(boundary + 1);
    }
  }, flush(controller) { pending += decoder.decode(); line(pending, controller); } });
}
async function boundedExit(exit, milliseconds) {
  let timer;
  await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]);
  clearTimeout(timer);
}
async function isolatedPaths(input) {
  const paths = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw failure('invalid_paths');
    paths[key] = await realpath(value).catch(() => { throw failure('invalid_paths'); });
    const info = await stat(paths[key]);
    if ((['codexHome', 'cwd'].includes(key) ? !info.isDirectory() : !info.isFile())) throw failure('invalid_paths');
  }
  for (const daily of [join(homedir(), '.codex'), process.env.CODEX_HOME].filter(Boolean)) {
    const actual = await realpath(daily).catch(() => daily);
    if (samePath(paths.codexHome, actual)) throw failure('daily_home_forbidden');
  }
  return paths;
}
