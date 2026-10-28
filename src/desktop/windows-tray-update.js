import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJsonFile } from '../storage/json-file.js';
import { windowsDesktopClient } from './windows-desktop-client.js';
import { downloadWindowsTrayRelease } from './windows-tray-release.js';

// The console's one-click update of a per-user Windows (tray) installation:
// download and verify the release's tray package, close the desktop client
// (the tray app), run that package's own Update-Fuli (the same update the
// double-click runs: stop, switch, start, reconnect clients, roll back on
// failure; data and the previous version are kept), then open the client of
// whichever version is installed afterwards. Runs in the console's detached
// update worker.

const UPDATE_TIMEOUT_MS = 30 * 60_000;

// installation: the installed record (installation.json) of this package.
// Returns { status: 'updated', version, clients }; throws with .blockers when running
// FULI processes blocked the switch.
export async function updateWindowsTrayFromRelease({ installation, version, stopPids = [], progress = () => {} }, {
  download = downloadWindowsTrayRelease, desktopClient = windowsDesktopClient, runUpdate = runPackagedUpdate,
  tempRoot = tmpdir()
} = {}) {
  const directory = mkdtempSync(join(tempRoot, 'fuli-tray-update-'));
  let clientWasRunning = false;
  try {
    const source = await download(version, directory, { progress });
    progress('exitingTray');
    clientWasRunning = await desktopClient.close(installation.dataDir) === 'exited';
    progress('installing');
    const resultFile = join(directory, 'result.json');
    const code = await runUpdate(source, ['--yes', '--install-root', installation.installRoot, '--result-file', resultFile,
      ...(stopPids.length ? ['--stop-pid', stopPids.join(',')] : [])]);
    const result = readJsonFile(resultFile, null);
    // clients: whether Update-Fuli reconnected the already connected clients
    // ('reconnected' or 'not_reconnected'); the console's doctor reads it from the journal.
    if (result?.status === 'updated') return { status: 'updated', version: result.applicationVersion, clients: result.clients ?? null };
    throw Object.assign(new Error(result?.error ?? `The update ended without an outcome (exit ${code}); nothing was reported.`),
      result?.blockers ? { blockers: result.blockers } : {});
  } finally {
    // The client of the version installed now: the new one, or the kept one after a rollback.
    if (clientWasRunning) desktopClient.reopen(installation.installRoot);
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
