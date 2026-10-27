import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJsonFile } from '../storage/json-file.js';
import { requestWindowsTrayExit } from './windows-update-lock.js';
import { downloadWindowsTrayRelease } from './windows-tray-release.js';

// The console's one-click update of a per-user Windows (tray) installation:
// download and verify the release's tray package, ask the tray to exit, run
// that package's own Update-Fuli (the same update the double-click runs:
// stop, switch, start, reconnect clients, roll back on failure; data and the
// previous version are kept), then open the tray of whichever version is
// installed afterwards. Runs in the console's detached update worker.

// A busy tray finishes its operation (bounded to about three minutes) before it exits.
const TRAY_EXIT_TIMEOUT_MS = 200_000;
const UPDATE_TIMEOUT_MS = 30 * 60_000;

// installation: the installed record (installation.json) of this package.
// Returns { status: 'updated', version }; throws with .blockers when running
// FULI processes blocked the switch.
export async function updateWindowsTrayFromRelease({ installation, version, stopPids = [], progress = () => {} }, {
  download = downloadWindowsTrayRelease, exitTray = requestWindowsTrayExit, runUpdate = runPackagedUpdate,
  launchTray = launchWindowsTray, tempRoot = tmpdir()
} = {}) {
  const directory = mkdtempSync(join(tempRoot, 'fuli-tray-update-'));
  let trayWasRunning = false;
  try {
    const source = await download(version, directory, { progress });
    progress('exitingTray');
    const tray = await exitTray(installation.dataDir, { timeoutMs: TRAY_EXIT_TIMEOUT_MS });
    if (tray === 'busy') throw new Error('The Fuli tray did not exit; nothing was installed. Close its open message and try again.');
    trayWasRunning = tray === 'exited';
    progress('installing');
    const resultFile = join(directory, 'result.json');
    const code = await runUpdate(source, ['--yes', '--install-root', installation.installRoot, '--result-file', resultFile,
      ...(stopPids.length ? ['--stop-pid', stopPids.join(',')] : [])]);
    const result = readJsonFile(resultFile, null);
    if (result?.status === 'updated') return { status: 'updated', version: result.applicationVersion };
    throw Object.assign(new Error(result?.error ?? `The update ended without an outcome (exit ${code}); nothing was reported.`),
      result?.blockers ? { blockers: result.blockers } : {});
  } finally {
    // The tray of the version installed now: the new one, or the kept one after a rollback.
    if (trayWasRunning) {
      const record = readJsonFile(join(installation.installRoot, 'installation.json'), null);
      if (record?.packageRoot) launchTray(record.packageRoot);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

// Update-Fuli.cmd's command from the verified package, with its own Node.
function runPackagedUpdate(source, args) {
  return new Promise(resolve => {
    execFile(join(source, 'runtime', 'node', 'node.exe'), [join(source, 'src', 'desktop', 'windows-update-command.js'), ...args],
      { cwd: source, windowsHide: true, timeout: UPDATE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      error => resolve(error ? error.code ?? 1 : 0));
  });
}

function launchWindowsTray(packageRoot) {
  const tray = join(packageRoot, 'Fuli.exe');
  if (!existsSync(tray)) return;
  const child = spawn(tray, [], { cwd: packageRoot, detached: true, stdio: 'ignore' });
  child.once('error', () => {});
  child.unref();
}
