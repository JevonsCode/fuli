import { execFile, spawn } from 'node:child_process';
import { constants, accessSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { readMacosNativeBundle } from '../native-runtime/macos-assets.js';
import { downloadVerifiedReleaseAsset, failure } from './release-asset.js';

// The console's one-click update of FULI.app, the macOS twin of the Windows
// tray update (windows-tray-update.js): download and verify the release's
// .dmg, copy the new FULI.app next to the installed one, stop FULI and close
// its window, swap the two bundles, start FULI from the new one, refresh the
// Agent clients that were already connected (setup --connected-only, as the
// Windows switch does) and open its window again. A new version that does not start is swapped back and the
// previous one started again. The data directory is never touched. Runs in
// the console's detached update worker, on the old bundle's Node, which keeps
// running after its bundle moves.
//
// Failures carry .code for the page's Chinese message: not_installed,
// no_permission, download_failed, checksum_mismatch, start_failed (rolled back),
// rollback_failed.

const HDIUTIL = '/usr/bin/hdiutil';
const DITTO = '/usr/bin/ditto';
const XATTR = '/usr/bin/xattr';
const OPEN = '/usr/bin/open';
const PS = '/bin/ps';
const CONTROLLER_TIMEOUT_MS = 10 * 60_000;
const CLIENT_EXIT_TIMEOUT_MS = 15_000;

const macosDmgName = (version, arch) => `fuli-macos-${arch}-${version}.dmg`;

// packageRoot: FULI.app/Contents/Resources/fuli of the running app.
// Returns { status: 'updated', version, clients: 'reconnected' | 'not_reconnected' }.
export async function updateMacosAppFromRelease({ packageRoot, dataDir, version, progress = () => {} }, {
  download = downloadVerifiedReleaseAsset, runCommand = run, controller = runController, cli = runCli,
  client = macosDesktopClient, readBundle = readMacosNativeBundle, tempRoot = tmpdir(), env = process.env
} = {}) {
  const app = installedApp(packageRoot);
  const { arch } = readBundle(packageRoot);
  const parent = dirname(app);
  const staged = join(parent, `.${basename(app)}.update`);
  const previous = join(parent, `.${basename(app)}.previous`);
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
    const stopped = await controller(packageRoot, 'stop', env);
    if (!stopped.ok) {
      if (clientWasRunning) client.open(app);
      throw new Error(`FULI did not stop before the update; nothing was changed. ${stopped.error ?? ''}`.trim());
    }
    rmSync(previous, { recursive: true, force: true });
    swap(app, staged, previous);
    const started = await controller(bundleRoot(app), 'start', env);
    if (!started.ok) {
      await rollBack({ app, previous, env, controller });
      if (clientWasRunning) client.open(app);
      throw failure(`v${version} did not start, so the previous version was restored and started again. ${started.error ?? ''}`.trim(),
        'start_failed');
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

async function rollBack({ app, previous, env, controller }) {
  try {
    await controller(bundleRoot(app), 'stop', env);
    rmSync(app, { recursive: true, force: true });
    renameSync(previous, app);
    const restarted = await controller(bundleRoot(app), 'start', env);
    if (!restarted.ok) throw new Error(restarted.error ?? 'The previous version did not start.');
  } catch (error) {
    throw failure(`The new version did not start and restoring the previous one failed: ${error?.message ?? error}`,
      'rollback_failed');
  }
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
