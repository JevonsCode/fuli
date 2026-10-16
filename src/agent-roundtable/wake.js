import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { WAKE_CLIENTS, wakeAdapter } from '../agents/wake-registry.js';

// Wakes the recipient Agent in its own client, headlessly and read-only, and
// returns its final answer with that conversation's full context. Each client's
// command, arguments, session lookup and output format live in its adapter.
export { WAKE_CLIENTS };
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;

function adapterFor(client) {
  const adapter = wakeAdapter(client);
  if (!adapter) throw new TypeError(`Unsupported client: ${client}`);
  return adapter;
}

export function resolveClientCommand(client, { env = process.env, platform = process.platform,
  fileExists = existsSync, which = whichCommand } = {}) {
  return wakeAdapter(client)?.resolveCommand({ env, platform, fileExists, which }) ?? null;
}

export function wakeArguments(client, { sessionId = null, cwd } = {}) {
  if (sessionId !== null && !SESSION_ID.test(sessionId)) throw new TypeError('Invalid client session id');
  return adapterFor(client).args({ sessionId, cwd });
}

// Clients only resume a conversation from the directory it started in.
export function sessionWorkingDirectory(client, sessionId, { home = homedir(), env = process.env } = {}) {
  if (!SESSION_ID.test(sessionId)) return null;
  return wakeAdapter(client)?.sessionDirectory(sessionId, { home, env }) ?? null;
}

export async function wakeAgent({ client, sessionId = null, cwd, prompt, timeoutMs = 300_000,
  delegationToken = null, peerDepth = null, env = process.env, run = runProcess, signal, onSpawn } = {}) {
  const command = resolveClientCommand(client, { env });
  if (!command) throw Object.assign(new Error(`${client} is not installed on this machine`), { code: 'client_unavailable' });
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('FULI_ROUNDTABLE_')));
  if (delegationToken) childEnv.FULI_ROUNDTABLE_DELEGATION = delegationToken;
  if (peerDepth) childEnv.FULI_ROUNDTABLE_PEER_DEPTH = String(peerDepth);
  const result = await run(command, wakeArguments(client, { sessionId, cwd }),
    { cwd, env: childEnv, input: prompt, timeoutMs, signal, onSpawn });
  return parseFinalAnswer(client, result);
}

export function parseFinalAnswer(client, { code, stdout }) {
  const adapter = adapterFor(client);
  const state = adapter.initialState();
  let sessionId = null;
  for (const line of stdout.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    sessionId ??= event.thread_id ?? event.session_id ?? null;
    adapter.readEvent(event, state);
    if (event.error === 'authentication_failed') {
      throw Object.assign(new Error(`${client} is not logged in on this machine`), { code: 'client_login_required' });
    }
  }
  if (code !== 0 || state.failed || !state.completed || !state.body.trim()) {
    throw Object.assign(new Error(`${client} did not return an answer`), { code: 'wake_failed' });
  }
  return { body: state.body.trim(), sessionId };
}

// Owns exactly one child process tree and never touches unrelated clients.
export function runProcess(command, args, { cwd, env, input, timeoutMs, maxOutputBytes = 4_000_000, signal, onSpawn }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('The delivery was cancelled before it started'), { code: 'cancelled', started: false }));
      return;
    }
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.once('spawn', () => onSpawn?.());
    let output = '', bytes = 0, settled = false;
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
        if (child.pid) {
          try { await kill(); }
          catch (cleanupError) { error.cleanup = { status: 'unconfirmed', code: cleanupError.code }; }
        }
        reject(error);
      } else resolve({ code, stdout: output });
    };
    const abort = () => finish(Object.assign(new Error('The delivery was cancelled'),
      { code: 'cancelled', reason: String(signal.reason ?? 'cancelled') }));
    const timer = setTimeout(() => finish(Object.assign(new Error('The woken Agent did not answer in time'), { code: 'wake_timeout' })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) finish(Object.assign(new Error('The woken Agent produced too much output'), { code: 'wake_failed' }));
      else output += chunk.toString('utf8');
    });
    child.on('error', () => finish(Object.assign(new Error('The client could not be started'), { code: 'client_unavailable' })));
    child.on('close', (code) => finish(null, code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
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
