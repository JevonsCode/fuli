import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { settledWithin } from './bounded-wait.js';
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
// How an app process ended: exited (code 0), load_failed (it ended before the
// launcher reported its entry loaded) or crashed (any other end after that).
// Nothing the app wrote is read or kept: no output, no error text.
const EXIT_CATEGORIES = Object.freeze({ exited: 'exited', loadFailed: 'load_failed', crashed: 'crashed' });
// The launcher's ready signal arrives on this descriptor; after an exit, its
// last byte is waited for this long at most.
const READY_FD = 3;
const READY_FLUSH_MS = 500;

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
//   signal, category }) is called once when the process has ended, for any
//   reason, with one of EXIT_CATEGORIES;
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
      stdio: ['pipe', 'ignore', 'ignore', 'pipe'], shell: false, windowsHide: true
    });
    const ready = child.stdio[READY_FD];
    let loaded = false;
    ready.once('data', () => { loaded = true; });
    ready.on('error', () => {});
    // An exit may be reported before the ready byte is read; the pipe closes after both.
    const readyClosed = new Promise((resolve) => ready.once('close', resolve));
    child.once('exit', (code, signal) => {
      settledWithin(readyClosed, READY_FLUSH_MS).then(() => onExit({ code, signal, category: exitCategory(code, signal, loaded) }));
    });
    await started(child);
    // A later error (the pipe of an exited app, a failed kill) shows in the stop that follows.
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    for (const each of [child, child.stdin, ready]) each.unref?.();
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

function exitCategory(code, signal, loaded) {
  if (code === 0 && !signal) return EXIT_CATEGORIES.exited;
  return loaded ? EXIT_CATEGORIES.crashed : EXIT_CATEGORIES.loadFailed;
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

