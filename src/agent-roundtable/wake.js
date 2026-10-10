import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

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
  env = process.env, run = runProcess } = {}) {
  const command = resolveClientCommand(client, { env });
  if (!command) throw Object.assign(new Error(`${client} is not installed on this machine`), { code: 'client_unavailable' });
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('FULI_ROUNDTABLE_')));
  const result = await run(command, wakeArguments(client, { sessionId, cwd }), { cwd, env: childEnv, input: prompt, timeoutMs });
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
export function runProcess(command, args, { cwd, env, input, timeoutMs, maxOutputBytes = 4_000_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', bytes = 0, settled = false;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
    };
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { kill(); reject(error); } else resolve({ code, stdout: output });
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('The woken Agent did not answer in time'), { code: 'wake_timeout' })), timeoutMs);
    child.stdout.on('data', (chunk) => {
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

function whichCommand(name, platform) {
  const result = spawnSync(platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  // On Windows only real executables can be spawned without a shell.
  return result.stdout.split(/\r?\n/).map((line) => line.trim())
    .find((line) => line && (platform !== 'win32' || /\.exe$/i.test(line))) ?? null;
}
