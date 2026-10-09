import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Wakes the recipient Agent in its own client, headlessly, and returns its
// final answer with that conversation's full context. Claude Code forks the
// session so an open window is never written concurrently; Codex records the
// exchange in the conversation and refuses while it is open in the app.
// Recipients run read-only.
export const WAKE_CLIENTS = Object.freeze(['claude_code', 'codex']);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;

export function resolveClientCommand(client, { env = process.env, platform = process.platform,
  fileExists = existsSync, which = whichCommand } = {}) {
  if (client === 'claude_code') return env.FULI_CLAUDE_BIN || which('claude', platform);
  if (client === 'codex') {
    if (env.FULI_CODEX_BIN) return env.FULI_CODEX_BIN;
    const found = which('codex', platform);
    if (found) return found;
    if (platform === 'win32') return newestBundledCodex(join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin'));
    const bundled = platform === 'darwin' ? '/Applications/Codex.app/Contents/Resources/codex' : null;
    return bundled && fileExists(bundled) ? bundled : null;
  }
  return null;
}

export function wakeArguments(client, { sessionId = null, cwd } = {}) {
  if (sessionId !== null && !SESSION_ID.test(sessionId)) throw new TypeError('Invalid client session id');
  if (client === 'claude_code') {
    return ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
      ...(sessionId ? ['--resume', sessionId, '--fork-session'] : [])];
  }
  if (client === 'codex') {
    return sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', sessionId, '-']
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd, '-'];
  }
  throw new TypeError(`Unsupported client: ${client}`);
}

// Both clients only resume a conversation from the directory it started in.
export function sessionWorkingDirectory(client, sessionId, { home = homedir(), env = process.env } = {}) {
  if (!SESSION_ID.test(sessionId)) return null;
  if (client === 'claude_code') {
    const root = join(home, '.claude', 'projects');
    for (const project of safeList(root)) {
      const file = join(root, project, `${sessionId}.jsonl`);
      if (existsSync(file)) return firstField(file, (line) => line.cwd);
    }
    return null;
  }
  if (client === 'codex') {
    const file = findFile(join(env.CODEX_HOME || join(home, '.codex'), 'sessions'), `${sessionId}.jsonl`, 4);
    return file ? firstField(file, (line) => line.type === 'session_meta' ? line.payload?.cwd : null) : null;
  }
  return null;
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
  let body = '', sessionId = null, failed = code !== 0, completed = client !== 'codex';
  for (const line of stdout.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    sessionId ??= event.thread_id ?? event.session_id ?? null;
    if (client === 'codex') {
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') body = event.item.text ?? '';
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed' || event.type === 'error') failed = true;
    } else if (event.type === 'result') {
      body = event.result ?? '';
      failed ||= Boolean(event.is_error);
    }
    if (event.error === 'authentication_failed') {
      throw Object.assign(new Error(`${client} is not logged in on this machine`), { code: 'client_login_required' });
    }
  }
  if (failed || !completed || !body.trim()) {
    throw Object.assign(new Error(`${client} did not return an answer`), { code: 'wake_failed' });
  }
  return { body: body.trim(), sessionId };
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

// The Codex app keeps each CLI version in its own folder; the newest is current.
function newestBundledCodex(root) {
  const candidates = [join(root, 'codex.exe'), ...safeList(root).map((entry) => join(root, entry, 'codex.exe'))]
    .filter((path) => existsSync(path));
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

function safeList(directory) {
  try { return readdirSync(directory); } catch { return []; }
}

function findFile(directory, suffix, depth) {
  for (const entry of safeList(directory).sort().reverse()) {
    const path = join(directory, entry);
    if (entry.endsWith(suffix)) return path;
    if (depth > 0 && !entry.includes('.')) {
      const found = findFile(path, suffix, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function firstField(file, pick) {
  const handle = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const length = readSync(handle, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, length).toString('utf8').split('\n')) {
      try { const value = pick(JSON.parse(line)); if (typeof value === 'string' && value) return value; } catch { /* partial line */ }
    }
    return null;
  } finally { closeSync(handle); }
}
