import { execFile, spawn } from 'node:child_process';
import { constants, accessSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { dataNewerThanThisPackage } from '../data-format/data-newer-than-package.js';
import { waitForConsoleStarts } from '../local-runtime/console-autostart-record.js';
import { readMacosNativeBundle } from '../native-runtime/macos-assets.js';
import {
  consoleLeftRunning, consoleStillRunning, failedStartError, keepNewVersionOnNewerData, newVersionDidNotStop,
  previousVersionBlocked, reasonText, startsBusyBeforeUpdate, startsStillRunning
} from './failed-update-recovery.js';
import { downloadVerifiedReleaseAsset, failure } from './release-asset.js';

// The console's one-click update of FULI.app, the macOS twin of the Windows
// tray update (windows-tray-update.js): download and verify the release's
// .dmg, copy the new FULI.app next to the installed one, stop FULI and close
// its window, swap the two bundles, start FULI from the new one, refresh the
// Agent clients that were already connected (setup --connected-only, as the
// Windows switch does) and open its window again. A new version that does not
// start is swapped back only when it stopped and the previous one can run on
// the data (recover below). The data directory is never touched. Runs in
// the console's detached update worker, on the old bundle's Node, which keeps
// running after its bundle moves.
//
// Failures carry .code for the page's Chinese message: not_installed,
// no_permission, download_failed, checksum_mismatch, start_failed (rolled back
// and the previous version runs), rollback_failed (switching back did not
// finish), kept_new_version (the new version stays installed: it would not stop,
// or the data is already too new for the previous one). The message names the
// new version's first start error and what was done after it, on one line.

const HDIUTIL = '/usr/bin/hdiutil';
const DITTO = '/usr/bin/ditto';
const XATTR = '/usr/bin/xattr';
const OPEN = '/usr/bin/open';
const PS = '/bin/ps';
const CONTROLLER_TIMEOUT_MS = 10 * 60_000;
const CLIENT_EXIT_TIMEOUT_MS = 15_000;

export const macosDmgName = (version, arch) => `fuli-macos-${arch}-${version}.dmg`;

// packageRoot: FULI.app/Contents/Resources/fuli of the running app.
// Returns { status: 'updated', version, clients: 'reconnected' | 'not_reconnected' }.
export async function updateMacosAppFromRelease({ packageRoot, dataDir, version, progress = () => {} }, {
  download = downloadVerifiedReleaseAsset, runCommand = run, controller = runController, cli = runCli,
  client = macosDesktopClient, readBundle = readMacosNativeBundle, tempRoot = tmpdir(), env = process.env,
  dataNewer = dataNewerThanThisPackage, holdStarts = waitForConsoleStarts, consolesLeft = consoleLeftRunning,
  rename = renameSync
} = {}) {
  const app = installedApp(packageRoot);
  const { arch } = readBundle(packageRoot);
  const parent = dirname(app);
  const staged = join(parent, `.${basename(app)}.update`);
  const previous = join(parent, `.${basename(app)}.previous`);
  const failed = join(parent, `.${basename(app)}.failed`);
  const directory = mkdtempSync(join(tempRoot, 'fuli-app-update-'));
  try {
    const dmg = await download({ version, name: macosDmgName(version, arch), directory, what: 'macOS app image' }, { progress });
    progress('preparing');
    rmSync(staged, { recursive: true, force: true });
    await stageApp(dmg, join(directory, 'volume'), staged, runCommand);
    const stagedVersion = packageVersion(bundleRoot(staged));
    if (stagedVersion !== version) {
      throw failure(`The macOS app image for v${version} contains v${stagedVersion}; nothing was installed.`, 'download_failed');
    }

    progress('restarting');
    const clientWasRunning = await client.close(app);
    // A stop sees only a console a finished start recorded, so it runs once no
    // start (an Agent session's automatic one) is under way, and the bundles
    // are swapped before any start may begin: none runs from the old bundle
    // after its stop. The new version's own start takes the lock itself.
    let release;
    try { release = holdStarts(dataDir); } catch (error) {
      if (clientWasRunning) client.open(app);
      throw startsBusyBeforeUpdate(error);
    }
    try {
      const stopped = await controller(packageRoot, 'stop', env);
      if (!stopped.ok) {
        if (clientWasRunning) client.open(app);
        throw new Error(`FULI did not stop before the update; nothing was changed. ${stopped.error ?? ''}`.trim());
      }
      rmSync(previous, { recursive: true, force: true });
      rmSync(failed, { recursive: true, force: true });
      swap(app, staged, previous);
    } finally { release(); }
    const started = await controller(bundleRoot(app), 'start', env);
    if (!started.ok) {
      const recovered = await recover({ app, previous, failed, dataDir, env, controller, dataNewer, holdStarts, consolesLeft, rename });
      if (!recovered.ok) {
        if (clientWasRunning) client.open(app);
        throw failedStartError(version, started.error, recovered);
      }
    }
    // The clients' MCP entries name paths inside FULI.app, which stay the same;
    // their Skills and hooks come from the new version's client packs.
    const reconnect = await cli(bundleRoot(app), ['setup', '--yes', '--connected-only', '--data-dir', dataDir], env);
    if (clientWasRunning) client.open(app);
    rmSync(previous, { recursive: true, force: true });
    return { status: 'updated', version, clients: reconnect.code === 0 ? 'reconnected' : 'not_reconnected' };
  } finally {
    rmSync(staged, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}

// The app this package belongs to, where it can be replaced: an app opened
// from the disk image or a translocated copy runs from a read-only place.
function installedApp(packageRoot) {
  const app = resolve(packageRoot, '..', '..', '..');
  if (!app.endsWith('.app') || app.startsWith('/Volumes/') || app.includes('/AppTranslocation/')) {
    throw failure('FULI is not running from the Applications folder, so it cannot replace itself; nothing was changed.',
      'not_installed');
  }
  try {
    accessSync(dirname(app), constants.W_OK);
    accessSync(app, constants.W_OK);
  } catch {
    throw failure(`This account may not replace ${app}; nothing was changed.`, 'no_permission');
  }
  return app;
}

const bundleRoot = app => join(app, 'Contents', 'Resources', 'fuli');
const packageVersion = root => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

// Copies FULI.app out of the image next to the installed one (same volume, so
// the swap is two renames). A copy made by FULI carries no quarantine flag;
// clearing it anyway keeps Gatekeeper from asking again for an unsigned build.
async function stageApp(dmg, mount, staged, runCommand) {
  mkdirSync(mount, { recursive: true });
  await runCommand(HDIUTIL, ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount]);
  try {
    try {
      await runCommand(DITTO, [join(mount, 'FULI.app'), staged]);
    } catch (error) {
      throw permissionAware(error, 'The new FULI.app could not be copied next to the installed one; nothing was changed.');
    }
  } finally {
    await runCommand(HDIUTIL, ['detach', mount, '-force']).catch(() => {});
  }
  await runCommand(XATTR, ['-dr', 'com.apple.quarantine', staged]).catch(() => {});
}

function swap(app, staged, previous) {
  try {
    renameSync(app, previous);
  } catch (error) {
    throw permissionAware(error, 'The installed FULI.app could not be moved aside; nothing was changed.');
  }
  try {
    renameSync(staged, app);
  } catch (error) {
    renameSync(previous, app);
    throw permissionAware(error, 'The new FULI.app could not be put in place; the previous one was kept.');
  }
}

// macOS refuses changes to an app bundle without App Management permission
// (System Settings > Privacy & Security) with EPERM.
function permissionAware(error, message) {
  const denied = ['EPERM', 'EACCES'].includes(error?.code) || /Operation not permitted|Permission denied/.test(error?.message ?? '');
  return failure(`${message} ${error?.message ?? ''}`.trim(), denied ? 'no_permission' : 'download_failed');
}

// After the new version's start was reported failed. Its first start may only
// be slow (stores upgrade, Neo4j starts cold), so nothing is moved before it
// stopped: a bundle is never moved or deleted under a FULI that runs from it.
// The previous version comes back only when it can run on the data the new one
// may already have upgraded; otherwise the new one stays and is started once
// more, so the app on disk always matches the data. The new bundle is set
// aside, not deleted, until the previous version runs.
// Answers { ok: true } when the new version runs after all, else
// { ok: false, code, outcome }: what was done, as one sentence.
// A stop sees only a console a finished start recorded. Another start (an
// Agent session's automatic one, console-autostart.js) may still be bringing
// one up, so the stop runs once no start is under way, and no start (a
// person's included) begins until the update's own next start: none may run
// while the data is read or a bundle moves. That start takes the lock itself.
async function recover(context) {
  let held;
  try { held = context.holdStarts(context.dataDir); } catch (error) { return startsStillRunning(error); }
  let released = false;
  const release = () => { if (!released) { released = true; held(); } };
  try { return await recoverHoldingStarts(context, release); } finally { release(); }
}

async function recoverHoldingStarts({ app, previous, failed, dataDir, env, controller, dataNewer, consolesLeft, rename }, release) {
  const start = () => { release(); return controller(bundleRoot(app), 'start', env); };
  const stopped = await controller(bundleRoot(app), 'stop', env);
  if (!stopped.ok) return newVersionDidNotStop(stopped.error);
  // A console the failed start left, unrecorded, may still upgrade stores or hold its port.
  const left = await consolesLeft(dataDir);
  if (left) return consoleStillRunning(left);
  const kept = await keepNewVersionOnNewerData(previousVersionBlocked(() => dataNewer(dataDir)), start);
  if (kept) return kept;
  try {
    rename(app, failed);
    rename(previous, app);
  } catch (error) {
    try { if (!existsSync(app) && existsSync(failed)) rename(failed, app); } catch { /* said below */ }
    const reason = reasonText(error?.message ?? error);
    return { ok: false, code: 'rollback_failed', outcome: existsSync(app)
      ? `switching back to the previous version failed, so the new one stays (${reason}).`
      : `switching back to the previous version failed and nothing is installed at ${app}: the new version is at ${failed} `
        + `and the previous one at ${previous} (${reason}).` };
  }
  const restarted = await start();
  if (!restarted.ok) {
    return { ok: false, code: 'rollback_failed',
      outcome: `the previous version was restored but did not start either (${reasonText(restarted.error)}).` };
  }
  rmSync(failed, { recursive: true, force: true });
  return { ok: false, code: 'start_failed', outcome: 'the previous version was restored and started again.' };
}

// The bundled controller the desktop client itself runs (macos-controller.js).
function runController(root, action, env) {
  return new Promise(resolveRun => {
    execFile(join(root, 'runtime', 'node', 'bin', 'node'), [join(root, 'src', 'desktop', 'macos-controller.js'), action],
      { cwd: root, env, encoding: 'utf8', timeout: CONTROLLER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        const line = String(stdout ?? '').trim().split('\n').pop();
        try { resolveRun(JSON.parse(line)); }
        catch { resolveRun({ ok: false, error: error?.message ?? 'The FULI controller did not answer.' }); }
      });
  });
}

// The new bundle's CLI; its output is not kept (setup can print an access code).
function runCli(root, args, env) {
  return new Promise(resolveRun => {
    execFile(join(root, 'runtime', 'node', 'bin', 'node'), [join(root, 'src', 'cli.js'), ...args],
      { cwd: root, env, encoding: 'utf8', timeout: CONTROLLER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      error => resolveRun({ code: error ? error.code ?? 1 : 0 }));
  });
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: CONTROLLER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => error
        ? reject(Object.assign(new Error(String(stderr || error.message).trim()), { code: error.code }))
        : resolveRun(stdout));
  });
}

// The desktop client (desktop/flutter) of this app: its window closes while
// the bundle is swapped and opens again from the new one.
export const macosDesktopClient = {
  // Ends the client running from app; resolves whether one was running.
  async close(app, { list = listProcesses, signal = process.kill, wait = delay, now = Date.now } = {}) {
    const executable = app + '/Contents/MacOS/FULI';
    const pids = (await list()).filter(({ args }) => args === executable || args.startsWith(executable + ' '))
      .map(({ pid }) => pid);
    if (!pids.length) return false;
    for (const pid of pids) signal(pid, 'SIGTERM');
    const deadline = now() + CLIENT_EXIT_TIMEOUT_MS;
    while (pids.some(alive) && now() < deadline) await wait(250);
    for (const pid of pids.filter(alive)) signal(pid, 'SIGKILL');
    return true;

    function alive(pid) {
      try { signal(pid, 0); return true; } catch { return false; }
    }
  },
  open(app) {
    if (!existsSync(app)) return;
    const child = spawn(OPEN, [app], { detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.unref();
  }
};

async function listProcesses() {
  const out = await run(PS, ['-axww', '-o', 'pid=,args=']);
  return out.split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, args]) => ({ pid: Number(pid), args: args.trim() }));
}
