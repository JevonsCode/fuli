import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';

import { WAKE_CLIENTS, wakeAdapter } from '../agents/wake-registry.js';
import { wakeFailure } from './wake-failure.js';

// Wakes the recipient Agent in its own client, headlessly in the given mode, and
// returns its final answer with that conversation's full context. Each client's
// command, arguments, session lookup and output format live in its adapter.
export { WAKE_CLIENTS };
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;
const MODEL_LIMIT = 120;
// The last part of a client's stderr and stdout a failed wake keeps, never more.
const OUTPUT_TAIL_CHARS = 4096;

function adapterFor(client) {
  const adapter = wakeAdapter(client);
  if (!adapter) throw new TypeError(`Unsupported client: ${client}`);
  return adapter;
}

export function resolveClientCommand(client, { env = process.env, platform = process.platform,
  fileExists = existsSync, which = whichCommand } = {}) {
  return wakeAdapter(client)?.resolveCommand({ env, platform, fileExists, which }) ?? null;
}

// What a woken session may do, each adapter mapping it to its client's own
// switches: answer (the person's own rules), read_only (read and answer only),
// worktree_edit (also edit files in the folder it was woken in; each adapter constrains
// it its own way). mcpServer: FULI's own MCP server entry; given, a read_only or
// worktree_edit wake loads only that MCP server.
export const WAKE_MODES = Object.freeze(['answer', 'read_only', 'worktree_edit']);

export function wakeArguments(client, { sessionId = null, cwd, delegated = false, plannedSessionId = null, mode = 'answer',
  mcpServer = null } = {}) {
  if (sessionId !== null && !SESSION_ID.test(sessionId)) throw new TypeError('Invalid client session id');
  if (!WAKE_MODES.includes(mode)) throw new TypeError('Invalid wake mode');
  return adapterFor(client).args({ sessionId, cwd, delegated, plannedSessionId, mode, mcpServer });
}

// Clients only resume a conversation from the directory it started in.
export function sessionWorkingDirectory(client, sessionId, { home = homedir(), env = process.env } = {}) {
  if (!SESSION_ID.test(sessionId)) return null;
  return wakeAdapter(client)?.sessionDirectory(sessionId, { home, env }) ?? null;
}

// Whether the session's client shows a turn still running in it. A client that
// forks on resume (Claude Code) never joins a running turn and says nothing.
export function sessionTurnRunning(client, sessionId, { home = homedir(), env = process.env } = {}) {
  if (!SESSION_ID.test(sessionId)) return false;
  return wakeAdapter(client)?.turnRunning?.(sessionId, { home, env }) ?? false;
}

export async function wakeAgent({ client, sessionId = null, cwd, prompt, timeoutMs = 300_000,
  delegationToken = null, peerDepth = null, env = process.env, run = runProcess, signal, onSpawn, onSession, mode = 'answer',
  mcpServer = null } = {}) {
  const command = resolveClientCommand(client, { env });
  if (!command) throw wakeFailure('client_unavailable', 'client_not_found', `${client} is not installed on this machine`);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('FULI_ROUNDTABLE_')));
  if (delegationToken) childEnv.FULI_ROUNDTABLE_DELEGATION = delegationToken;
  if (peerDepth) childEnv.FULI_ROUNDTABLE_PEER_DEPTH = String(peerDepth);
  // A client that names its session up front is bound before it starts, so its
  // first hook already finds the delegation; others are bound when they report it.
  const plannedSessionId = onSession && adapterFor(client).plansSession ? randomUUID() : null;
  if (plannedSessionId) await onSession(plannedSessionId);
  let observedSession = null;
  const result = await run(command, wakeArguments(client, { sessionId, cwd, delegated: Boolean(delegationToken), plannedSessionId, mode, mcpServer }),
    { cwd, env: childEnv, input: prompt, timeoutMs, signal, onSpawn, onEvent: event => {
      const observed = adapterFor(client).nativeSessionId(event);
      if (!observed) return;
      if (!SESSION_ID.test(observed) || (observedSession && observedSession !== observed)
        || (plannedSessionId && observed !== plannedSessionId)) {
        throw Object.assign(new Error('The receiving native session changed'), { code: 'session_mismatch' });
      }
      if (observedSession) return;
      observedSession = observed;
      if (plannedSessionId) return;
      return onSession?.(observed);
    } });
  const answer = parseFinalAnswer(client, result);
  if (onSession && (!observedSession || answer.sessionId !== observedSession)) {
    throw Object.assign(new Error('No matching native session was observed'), { code: 'session_mismatch' });
  }
  return answer;
}

// code/signal: how the client exited; stderr: the tail runProcess kept.
export function parseFinalAnswer(client, { code, signal = null, stdout, stderr = '' }) {
  const adapter = adapterFor(client);
  const state = adapter.initialState();
  let sessionId = null;
  for (const line of stdout.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    sessionId ??= event.thread_id ?? event.session_id ?? null;
    adapter.readEvent(event, state);
    if (event.error === 'authentication_failed') {
      throw wakeFailure('client_login_required', 'login_required', `${client} is not logged in on this machine`,
        { exitCode: code, signal, output: { stderr } });
    }
  }
  if (code !== 0 || state.failed || !state.completed || !state.body.trim()) {
    throw wakeFailure('wake_failed', code !== 0 ? 'client_exit_nonzero' : 'no_final_answer', `${client} did not return an answer`,
      { exitCode: code, signal, output: { stderr, stdout: stdout.slice(-OUTPUT_TAIL_CHARS) } });
  }
  // model: as the client reported it, only where its adapter reads one.
  return { body: state.body.trim(), sessionId, ...(state.model ? { model: state.model.slice(0, MODEL_LIMIT) } : {}) };
}

// Owns exactly one child process tree and never touches unrelated clients.
export function runProcess(command, args, { cwd, env, input, timeoutMs, maxOutputBytes = 4_000_000, signal, onSpawn, onEvent }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(wakeFailure('cancelled', 'cancelled', 'The delivery was cancelled before it started'), { started: false }));
      return;
    }
    let child;
    // Windows refuses some files at once (EFTYPE); other systems report it as an error event.
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { reject(startFailure(error)); return; }
    const closed = new Promise((resolve) => child.once('close', resolve));
    // The PID is known as soon as spawn() returns: record it before anything can
    // lose the console, not on the later spawn event (rec#97).
    if (Number.isSafeInteger(child.pid)) onSpawn?.(child.pid);
    let output = '', pending = '', bytes = 0, settled = false, childClosed = false, exitSignal = null;
    const decoder = new StringDecoder('utf8');
    // Only the last part of stderr is kept, so a chatty client never grows memory.
    const errorDecoder = new StringDecoder('utf8');
    let stderr = '';
    const keepStderr = text => { stderr = (stderr + text).slice(-OUTPUT_TAIL_CHARS); };
    const captured = () => ({ stderr, stdout: output.slice(-OUTPUT_TAIL_CHARS) });
    const callbacks = new Set();
    let eventFailure = null;
    const emit = line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      let callback;
      try { callback = Promise.resolve(onEvent?.(event)); }
      catch (error) { callback = Promise.reject(error); }
      callbacks.add(callback);
      callback.catch(error => {
        eventFailure ??= error;
        if (!childClosed) void finish(error);
      }).finally(() => callbacks.delete(callback));
    };
    const append = text => {
      output += text;
      if (!onEvent) return;
      pending += text;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        emit(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    };
    const kill = async () => {
      let killing = Promise.resolve(0), deadline, deadlineReached = false;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killing = new Promise((resolve) => {
          let failure;
          killer.once('error', (error) => { failure = error.code; });
          killer.once('close', (code) => resolve(failure ?? code));
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
          killing = processGroupExited(child.pid, () => deadlineReached);
        } catch (error) { if (error.code !== 'ESRCH') killing = Promise.resolve(error.code); }
      }
      try {
        const [, killCode] = await Promise.race([
          Promise.all([closed, killing]),
          new Promise((_, reject) => { deadline = setTimeout(() => { deadlineReached = true; reject(
            Object.assign(new Error('Process cleanup could not be confirmed'), { code: 'cleanup_timeout' })); }, 5_000); }),
        ]);
        if (killCode !== 0) throw Object.assign(new Error('Process tree termination failed'), { code: 'cleanup_failed' });
      } finally { clearTimeout(deadline); }
    };
    const finish = async (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        error.output ??= captured();
        if (child.pid && !childClosed) {
          try { await kill(); }
          catch (cleanupError) { error.cleanup = { status: 'unconfirmed', code: cleanupError.code }; }
        }
        reject(error);
      } else resolve({ code, signal: exitSignal, stdout: output, stderr });
    };
    const abort = () => finish(Object.assign(wakeFailure('cancelled', 'cancelled', 'The delivery was cancelled'),
      { reason: String(signal.reason ?? 'cancelled') }));
    const timer = setTimeout(() => finish(wakeFailure('wake_timeout', 'timed_out', 'The woken Agent did not answer in time')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) finish(wakeFailure('wake_failed', 'output_too_large', 'The woken Agent produced too much output'));
      else append(decoder.write(chunk));
    });
    child.stderr.on('data', (chunk) => keepStderr(errorDecoder.write(chunk)));
    child.on('error', (error) => finish(startFailure(error)));
    child.on('close', async (code, closeSignal) => {
      childClosed = true;
      exitSignal = closeSignal ?? null;
      keepStderr(errorDecoder.end());
      if (settled) return;
      append(decoder.end());
      if (pending) emit(pending);
      await Promise.allSettled([...callbacks]);
      void finish(eventFailure, code);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function startFailure(error) {
  return wakeFailure('client_unavailable', error.code === 'ENOENT' ? 'client_not_found' : 'spawn_error',
    'The client could not be started');
}

// SIGKILL is delivered asynchronously and orphaned descendants are reaped by
// init, so the leader closing does not mean its group is gone. The group has
// exited only once the kernel no longer resolves any member of it.
async function processGroupExited(pgid, stopped) {
  while (!stopped()) {
    try { process.kill(-pgid, 0); }
    catch (error) { if (error.code === 'ESRCH') return 0; }
    await delay(10);
  }
}

function whichCommand(name, platform) {
  const result = spawnSync(platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  // On Windows only real executables can be spawned without a shell.
  return result.stdout.split(/\r?\n/).map((line) => line.trim())
    .find((line) => line && (platform !== 'win32' || /\.exe$/i.test(line))) ?? null;
}
