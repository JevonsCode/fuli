import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localRuntimeControl } from '../cli/local-runtime-control.js';
import { runUpdateCommand } from '../cli/update-command.js';
import { readWindowsInstallation } from '../desktop/windows-installation-context.js';
import { FULI_VERSION } from '../package-metadata.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { claimDetachedJob, detachedJob } from './detached-job.js';

// The console's 「更新」: the same update `fuli update --yes` runs (stop the
// local services, install the newest npm package, refresh the services and
// connected clients through the new version's setup). It stops the console,
// so a detached worker (detached-job.js) runs it and journals the outcome;
// the page follows the restart and reloads once the new version answers. A
// Windows per-user installation is updated by its own installer instead, so
// the console does not offer it there.

const JOURNAL = 'console-update.json';
const WORKER = fileURLToPath(new URL('./console-update-worker.js', import.meta.url));
const RUNNING = new Set(['updating']);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function consoleUpdate(dataDir, { packageRoot = PACKAGE_ROOT, platform = process.platform,
  installation = readWindowsInstallation, spawnWorker, now } = {}) {
  const job = detachedJob(join(dataDir, JOURNAL), { worker: WORKER, running: RUNNING, spawnWorker, now });
  const offered = () => platform !== 'win32' || !installation(packageRoot);
  function status() {
    const current = job.read();
    return current && { id: current.id, status: current.status, fromVersion: current.fromVersion,
      version: current.version ?? null, started: current.started ?? null, error: current.error ?? null };
  }
  return {
    offered,
    status,
    start() {
      if (!offered()) throw new TypeError('This installation is updated by its own installer, not from the console.');
      job.start(dataDir, { status: 'updating', fromVersion: FULI_VERSION }, 'The update could not start. Nothing was changed.');
      return status();
    }
  };
}

// The worker. Only the first line of a failure is kept: the lines after it
// are recovery commands for a terminal, and the console starts FULI again
// itself with whatever is installed now.
export async function runConsoleUpdate(paths, id, { update = runUpdateCommand, env = process.env,
  control = localRuntimeControl(paths, env, () => {}) } = {}) {
  const claimed = claimDetachedJob(join(paths.dataDir, JOURNAL), id, 'updating');
  if (!claimed) return;
  const { record } = claimed;
  // The default data directory is not named, so the update runs exactly as `fuli update --yes` does.
  const dataDirArgs = resolveSetupPaths({ env }).dataDir === paths.dataDir ? [] : ['--data-dir', paths.dataDir];
  try {
    const result = await update(['--yes', ...dataDirArgs], { env, write: () => {} });
    record({ status: result.status === 'updated' ? 'updated' : 'unchanged', version: result.version ?? null });
  } catch (error) {
    record({ status: 'failed', error: String(error?.message ?? error).split('\n')[0] });
    const started = await control.consoleRunning().then((running) => running || control.start().then(() => true))
      .catch(() => false);
    record({ started });
  }
}
