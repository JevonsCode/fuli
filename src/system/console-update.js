import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InvalidInputError } from '../app/application-error.js';
import { localRuntimeControl } from '../cli/local-runtime-control.js';
import { runUpdateCommand } from '../cli/update-command.js';
import { readWindowsInstallation } from '../desktop/windows-installation-context.js';
import { updateWindowsTrayFromRelease } from '../desktop/windows-tray-update.js';
import { FULI_VERSION } from '../package-metadata.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { claimDetachedJob, detachedJob } from './detached-job.js';

// The console's 「更新」. It stops the console, so a detached worker
// (detached-job.js) runs it and journals each step; the page follows the
// restart and reloads once the new version answers. An npm installation runs
// the same update `fuli update --yes` runs (stop, install the newest npm
// package, refresh services and connected clients through the new version's
// setup). A per-user Windows installation (the tray) downloads the release's
// verified tray package and runs its own Update-Fuli
// (src/desktop/windows-tray-update.js).

const JOURNAL = 'console-update.json';
const WORKER = fileURLToPath(new URL('./console-update-worker.js', import.meta.url));
const RUNNING = new Set(['updating']);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function consoleUpdate(dataDir, { packageRoot = PACKAGE_ROOT, platform = process.platform,
  installation = readWindowsInstallation, spawnWorker, now } = {}) {
  const job = detachedJob(join(dataDir, JOURNAL), { worker: WORKER, running: RUNNING, spawnWorker, now });
  const kind = () => platform === 'win32' && installation(packageRoot) ? 'windows-tray' : 'npm';
  function status() {
    const current = job.read();
    return current && { id: current.id, status: current.status, kind: current.kind ?? 'npm', fromVersion: current.fromVersion,
      targetVersion: current.targetVersion ?? null, version: current.version ?? null, step: current.step ?? null,
      started: current.started ?? null, error: current.error ?? null, blockers: current.blockers ?? null,
      clients: current.clients ?? null };
  }
  return {
    kind,
    status,
    // The doctor's repair reconnected the clients an update left unconnected.
    recordClientsReconnected(id) {
      return job.amend(id, { clients: 'reconnected' });
    },
    // version: the newer version found; a tray installation downloads exactly that one.
    // stopProcesses: "PID:created" of processes the last failed update named, which the person chose to stop.
    // channel: the update channel the version came from; an npm installation installs from it too.
    start({ version = null, channel = 'stable', stopProcesses = [] } = {}) {
      const updateKind = kind();
      if (updateKind === 'windows-tray' && !version) throw new InvalidInputError('No newer FULI version was found to update to.');
      const named = new Set((job.read()?.blockers ?? []).map(({ pid, createdFileTime }) => pid + ':' + createdFileTime));
      if (!Array.isArray(stopProcesses) || stopProcesses.some(item => !named.has(item))) {
        throw new InvalidInputError('stopProcesses may name only processes the last update reported; reload and try again.');
      }
      job.start(dataDir, { status: 'updating', kind: updateKind, fromVersion: FULI_VERSION, channel,
        ...(updateKind === 'windows-tray' ? { targetVersion: version, stopPids: stopProcesses } : {}) },
      'The update could not start. Nothing was changed.');
      return status();
    }
  };
}

// The worker. Only the first line of a failure is kept: the lines after it
// are recovery commands for a terminal, and the console starts FULI again
// itself with whatever is installed now.
export async function runConsoleUpdate(paths, id, { update = runUpdateCommand, updateTray = updateWindowsTrayFromRelease,
  installation = readWindowsInstallation, env = process.env, control = localRuntimeControl(paths, env, () => {}) } = {}) {
  const claimed = claimDetachedJob(join(paths.dataDir, JOURNAL), id, 'updating');
  if (!claimed) return;
  const { job, record } = claimed;
  // The default data directory is not named, so the update runs exactly as `fuli update --yes` does.
  const dataDirArgs = resolveSetupPaths({ env }).dataDir === paths.dataDir ? [] : ['--data-dir', paths.dataDir];
  try {
    const result = job.kind === 'windows-tray'
      ? await updateTray({ installation: installation(PACKAGE_ROOT), version: job.targetVersion, stopPids: job.stopPids,
        progress: step => record({ step }) })
      : await update(['--yes', ...(job.channel === 'beta' ? ['--beta'] : []), ...dataDirArgs], { env, write: () => {} });
    // clients: a tray update reports whether it reconnected the connected
    // clients; an npm update fails instead when its setup does not finish.
    record({ status: result.status === 'updated' ? 'updated' : 'unchanged', version: result.version ?? null,
      ...(result.clients ? { clients: result.clients } : {}) });
  } catch (error) {
    record({ status: 'failed', error: String(error?.message ?? error).split('\n')[0],
      ...(error?.blockers ? { blockers: error.blockers } : {}) });
    const started = await control.consoleRunning().then((running) => running || control.start().then(() => true))
      .catch(() => false);
    record({ started });
  }
}
