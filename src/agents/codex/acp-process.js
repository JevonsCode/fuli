import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { ApplicationError } from '../../app/application-error.js';
import { inspectWindowsNativeProcess, stopWindowsNativeProcess } from '../../native-runtime/windows-processes.js';

const AUTH = '_auth/status_update';
const AUTH_KINDS = new Set(['none', 'account', 'api_key', 'gateway', 'external']);
const OS_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP']);
const MAX_BYTES = 64 * 1024;
const samePath = (a, b) => normalize(a).toLowerCase() === normalize(b).toLowerCase();
const failure = code => new ApplicationError(`acp_${code}`, `Codex ACP ${code.replaceAll('_', ' ')}.`);

// One owned Windows adapter/app-server pair. Lease and WorkerRun policy stay with the host.
// This port intentionally exposes no session/new, prompt, authentication or hook operations.
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
  const child = spawn(nodePath, [paths.adapterPath], { cwd: paths.cwd, env: childEnv,
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false, exit, connection, closing, rootOwner, initialization, initializationCaptured = false, authentication = 'unknown';
  let stderrBytes = 0, stderrTruncated = false, requestedId = null, terminalError = null, timer;
  const owned = new Map(), permissions = [];
  const lifetime = new AbortController();
  let resolveClosed, rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void closed.catch(() => {});
  async function capture(timeoutMs) {
    if (exited) return false;
    const rows = await inspectWindowsNativeProcess(child.pid, { children: true, timeoutMs });
    if (exited) return false;
    const root = rows.find(row => row.pid === child.pid);
    if (!root?.executable || !samePath(root.executable, nodePath) || !root.commandLine?.includes(paths.adapterPath) ||
        (rootOwner && (root.createdFileTime !== rootOwner.createdFileTime || root.commandLine !== rootOwner.commandLine))) {
      throw failure('cleanup_incomplete');
    }
    rootOwner = root;
    owned.set(root.pid, root);
    for (const row of rows) if (row.parentPid === root.pid && row.executable && row.commandLine &&
        samePath(row.executable, paths.codexPath) && BigInt(row.createdFileTime) >= BigInt(root.createdFileTime)) {
      owned.set(row.pid, row);
    }
    return true;
  }
  function close(reason = failure('closed')) {
    if (closing) return closing;
    clearTimeout(timer);
    closing = Promise.resolve().then(async () => {
      lifetime.abort(failure('closed'));
      signal?.removeEventListener('abort', cancelled);
      const deadline = Date.now() + stopTimeoutMs;
      const remaining = () => {
        const value = deadline - Date.now();
        if (value <= 0) throw failure('cleanup_incomplete');
        return value;
      };
      try {
        if (!await capture(remaining()) && !initializationCaptured) throw failure('cleanup_incomplete');
        connection?.close(reason);
        child.stdin.end();
        await boundedExit(exit, Math.min(1500, remaining()));
        await capture(remaining());
        for (const owner of [...owned.values()].reverse()) {
          await stopWindowsNativeProcess(owner.pid, { pid: owner.pid, command: owner.executable, ownership: owner }, { timeoutMs: remaining() });
        }
        if (!exited) await boundedExit(exit, remaining());
        if (!exited) throw failure('cleanup_incomplete');
        resolveClosed();
      } catch {
        connection?.close(failure('cleanup_incomplete'));
        child.stdin.end();
        child.unref(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        const error = failure('cleanup_incomplete'); error.cleanupIncomplete = true;
        rejectClosed(error); throw error;
      }
    });
    return closing;
  }
  const cancelled = () => { terminalError ??= failure('cancelled'); void close(terminalError).catch(() => {}); };
  try {
    exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
    child.stderr.on('data', chunk => {
      stderrTruncated ||= stderrBytes + chunk.length > MAX_BYTES;
      stderrBytes = Math.min(MAX_BYTES, stderrBytes + chunk.length);
    });
    child.stdin.on('error', () => { void close(failure('closed')).catch(() => {}); });
    child.once('error', () => { void close(failure('spawn_failed')).catch(() => {}); });
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    if (closing) throw terminalError;
    timer = setTimeout(() => { terminalError ??= failure('timeout'); void close(terminalError).catch(() => {}); }, initializeRemaining());
    await Promise.race([once(child, 'spawn'), closed.then(() => { throw terminalError ?? failure('closed'); })]);
    if (!await capture(initializeRemaining())) throw failure('closed');
    if (closing) throw terminalError ?? failure('closed');
    const output = Writable.toWeb(child.stdin), writer = output.getWriter();
    const trackedOutput = new WritableStream({ write(chunk) {
      const message = JSON.parse(new TextDecoder().decode(chunk));
      if (message.method === methods.agent.initialize) requestedId = message.id;
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
      if (Object.hasOwn(message, 'method') || requestedId === null || message.id !== requestedId) throw failure('protocol_error');
      requestedId = null;
      return message;
    }));
    connection = client().onNotification(AUTH, value => value, ({ params }) => { authentication = params.kind; })
      .onRequest(methods.client.session.requestPermission, ({ params, requestId }) => {
        if (permissions.length < 16) permissions.push({ requestId, sessionId: params.sessionId.slice(0, 128),
          toolCallId: params.toolCall.toolCallId.slice(0, 128), optionKinds: params.options.slice(0, 16).map(option => option.kind) });
        return { outcome: { outcome: 'cancelled' } };
      }).connect(ndJsonStream(trackedOutput, filtered));
    void connection.closed.then(() => { void close(terminalError ?? failure('closed')).catch(() => {}); });
    const response = await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {}, clientInfo: { name: 'fuli', version: '1' } }, { cancellationSignal: signal });
    if (response.protocolVersion !== PROTOCOL_VERSION) throw failure('handshake_failed');
    initialization = { protocolVersion: response.protocolVersion, agentVersion: response.agentInfo?.version ?? null };
    if (!await capture(initializeRemaining())) throw failure('closed');
    initializationCaptured = true;
    if (closing) throw terminalError ?? failure('closed');
    return { pid: child.pid, initialization, signal: lifetime.signal, closed, close,
      get ownedPids() { return [...owned.keys()]; }, get authentication() { return authentication; },
      get pendingPermissions() { return structuredClone(permissions); },
      get diagnostics() { return { stderrBytes, stderrTruncated }; } };
  } catch (error) {
    const safe = terminalError ?? (error instanceof ApplicationError ? error : failure('handshake_failed'));
    await close(safe);
    throw safe;
  } finally { clearTimeout(timer); }
}

// Only this initialize exchange and auth/permission messages can reach the SDK.
// No generic RPC dispatcher or response schema replaces the SDK's own parser.
function initializationWireGuard(project) {
  let pending = '';
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  function line(value, controller) {
    if (!value.trim()) return;
    let message;
    try { message = JSON.parse(value); } catch { throw failure('protocol_error'); }
    if (!message || typeof message !== 'object') throw failure('protocol_error');
    controller.enqueue(encoder.encode(JSON.stringify(project(message)) + '\n'));
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
