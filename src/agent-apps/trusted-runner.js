import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { settledWithin } from './bounded-wait.js';
import { singleLine } from '../text/single-line.js';
import { utf8Preview } from '../text/utf8-preview.js';
import { appConflict } from './errors.js';
import { createHostIdentity } from './host-identity.js';
import { TRUST_MODE } from './trust-terms.js';

const LAUNCHER = fileURLToPath(new URL('./app-launcher.js', import.meta.url));
// A stop asks the process to end, then ends it, and waits this long for each.
const STOP_WAIT_MS = 5000;
// What a node process needs of the platform; nothing else of FULI's environment
// (provider tokens, model keys) is handed to an app.
// Names compare case-insensitively, as Windows does.
const PLATFORM_ENVIRONMENT = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']);
// Of an app's stderr only the start is read into memory, and of that only a
// short one-line summary is recorded when the app exits; nothing else is kept.
const STDERR_KEEP_BYTES = 8 * 1024;
const EXIT_SUMMARY_BYTES = 400;
// After an exit, its last stderr bytes arrive within this time or are not waited for.
const STDERR_FLUSH_MS = 500;
// What a summary must not show: app tokens, file URLs and absolute paths.
const TOKEN_TEXT = /fla_[A-Za-z0-9_-]{16,}/g;
const FILE_URL = /file:\/\/[^\s'"()]+/g;
// A path starts at a drive, a UNC prefix or a root slash, never inside a word (node:internal/modules stays).
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|(?<![\w:.])\/)(?:[^\s'"():]+[\\/])+[^\s'"():]*/g;

// The runner an app instance runs in (rec#7 D-28.2, rec#11 D-36.2). This
// version has no sandbox: the trusted runner starts the app's service entry
// as a node process of the user's own OS account, with the user's
// permissions. FULI does not isolate it: the app can read files, use the
// network or start processes itself; FULI's fences cover only what it asks of
// the FULI Host API. A sandboxed runner (AppContainer, bwrap, sandbox-exec,
// rec#37) implements the same contract:
// - kind, and selfCheck() → { ok: true } or { ok: false, detail }: the check
//   that must pass before every start (runner_check_failed otherwise);
// - start({ appId, instanceId, generation, mode, packageDirectory,
//   dataDirectory, manifest, environment, onExit }) → a handle { pid,
//   pidIdentity, exePath, socket } that keeps the runner's own reference to
//   the process; environment holds only FULI_APP_* values; onExit({ code,
//   signal, error }) is called once when the process has ended, for any
//   reason, error being a short redacted summary of its stderr or null;
// - stop(handle): stops the process through that reference and waits for its exit;
// - stopOrphan(instance): for an instance whose host has exited, answers once
//   its process is confirmed gone, or refuses. A runner never signals a
//   process by PID: the trusted runner stops only processes it holds.
//
// A page-only app (no runtime.entry) has no process. A service is started
// through app-launcher.js, which ends it when its host's pipe closes, so an
// app does not outlive the FULI process that started it; the child and its
// pipes do not keep that FULI process alive either.
// spawnProcess, nodePath, hostIdentity and environment are seams for tests.
export function createTrustedRunner({
  spawnProcess = spawn, nodePath = process.execPath, hostIdentity = createHostIdentity(), environment = process.env
} = {}) {
  async function selfCheck() {
    return existsSync(nodePath) && existsSync(LAUNCHER) ? { ok: true } : { ok: false, detail: 'node_missing' };
  }

  async function start({ manifest, packageDirectory, environment: appEnvironment, onExit = () => {} }) {
    if (!manifest.runtime.entry) return { pid: null, pidIdentity: null, exePath: null, socket: null, child: null };
    const child = spawnProcess(nodePath, [LAUNCHER, join(packageDirectory, manifest.runtime.entry)], {
      cwd: packageDirectory, env: { ...platformEnvironment(environment), ...appEnvironment },
      stdio: ['pipe', 'ignore', 'pipe'], shell: false, windowsHide: true
    });
    const stderr = capturedStart(child.stderr);
    child.once('exit', (code, signal) => {
      settledWithin(stderr.closed, STDERR_FLUSH_MS).then(() => onExit({ code, signal,
        error: exitSummary(stderr.text(), appEnvironment.FULI_APP_TOKEN) }));
    });
    await started(child);
    // A later error (the pipe of an exited app, a failed kill) shows in the stop that follows.
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    for (const each of [child, child.stdin, child.stderr]) each.unref?.();
    return { pid: child.pid, pidIdentity: await hostIdentity.identify(child.pid), exePath: nodePath, socket: null, child };
  }

  async function stop(handle) {
    const { child } = handle ?? {};
    if (!child || exited(child)) return;
    const exit = exitOf(child);
    child.kill();
    if (!await settledWithin(exit, STOP_WAIT_MS)) {
      child.kill('SIGKILL');
      if (!await settledWithin(exit, STOP_WAIT_MS)) {
        throw appConflict('stop_failed', `The app process ${child.pid} did not end`, { pid: child.pid });
      }
    }
    child.stdin.destroy();
  }

  // The process of an exited host, which this runner does not hold: it should
  // have ended with its host's pipe; only the OS confirming that ends the
  // instance. It is never signalled from here.
  async function stopOrphan(instance) {
    if (!instance.pid) return { stopped: false, reason: 'not_running' };
    const verdict = await hostIdentity.probe({ pid: instance.pid, identity: instance.pidIdentity });
    if (verdict === 'exited') return { stopped: true, reason: 'exited' };
    throw appConflict('orphan_running', `The app process ${instance.pid}, started by a FULI process that has exited, is still `
      + 'running or cannot be checked. FULI stops only processes it holds: end it yourself, then try again '
      + '(该应用进程由已退出的 FULI 启动，请先自行结束后重试).', { pid: instance.pid });
  }

  return { kind: TRUST_MODE, selfCheck, start, stop, stopOrphan };
}

function platformEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name, value]) => value !== undefined && PLATFORM_ENVIRONMENT.has(name.toUpperCase())));
}

// Reads the first STDERR_KEEP_BYTES of a stream and drains the rest unread.
function capturedStart(stream) {
  const chunks = [];
  let kept = 0;
  stream.on('data', (chunk) => {
    if (kept >= STDERR_KEEP_BYTES) return;
    chunks.push(chunk.subarray(0, STDERR_KEEP_BYTES - kept));
    kept += chunks.at(-1).length;
  });
  stream.on('error', () => {});
  return { closed: new Promise((resolve) => stream.once('close', resolve)),
    text: () => Buffer.concat(chunks).toString('utf8') };
}

// One bounded line of what the app wrote to stderr, without its token or any path.
function exitSummary(text, token) {
  const redacted = (token ? text.split(token).join('[token]') : text).replace(TOKEN_TEXT, '[token]')
    .replace(FILE_URL, '<path>').replace(ABSOLUTE_PATH, '<path>');
  return utf8Preview(singleLine(redacted).replace(/ {2,}/g, ' '), EXIT_SUMMARY_BYTES) || null;
}

function started(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

function exitOf(child) {
  return new Promise((resolve) => {
    if (exited(child)) resolve();
    else child.once('exit', () => resolve());
  });
}

