import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { restartLocalRuntime, startLocalRuntime } from '../local-runtime/lifecycle.js';
import { stopGraphProviders } from '../setup/graph-runtime.js';
import { writeRuntimeSettings } from './runtime-settings.js';
import { isProcessAlive } from '../local-runtime/processes.js';

const operationPath = (paths) => join(paths.dataDir, 'settings-apply.json');
function saveOperation(paths, value) {
  writeJsonFileAtomic(operationPath(paths), value);
  chmodSync(operationPath(paths), 0o600);
}

export function createSettingsApplier({ paths, checkPorts = checkChangedPorts,
  spawnWorker = spawn, writeSettings = writeRuntimeSettings } = {}) {
  let preparing = false;
  function status() {
    const job = readJsonFile(operationPath(paths), null);
    if (!job) return null;
    const interrupted = job.status === 'applying' && Date.now() - job.startedAt > 10000
      && !isProcessAlive(job.workerPid);
    return { id: job.id, status: interrupted ? 'failed' : job.status,
      port: job.configured.ports.console,
      error: interrupted ? 'Settings application was interrupted. Save again to retry.' : job.error,
      rolledBack: job.rolledBack };
  }
  return {
    status,
    async prepare(configured, previous) {
      if (preparing || status()?.status === 'applying') {
        throw new TypeError('Settings are already being applied. Please wait.');
      }
      preparing = true;
      try {
        await checkPorts(configured, previous);
        saveOperation(paths, { id: randomUUID(), status: 'applying', startedAt: Date.now(), configured, previous });
        try { writeSettings(paths.runtimeSettingsPath, configured); }
        catch (error) {
          const job = readJsonFile(operationPath(paths));
          saveOperation(paths, { ...job, status: 'failed', error: 'Could not save settings.' });
          throw error;
        }
        return status();
      } finally { preparing = false; }
    },
    start(id) {
      const job = readJsonFile(operationPath(paths), null);
      if (job?.id !== id || job.status !== 'applying' || job.workerPid) return;
      const fail = () => {
        writeSettings(paths.runtimeSettingsPath, job.previous);
        saveOperation(paths, { ...job, status: 'failed', rolledBack: true,
          error: 'Could not start settings application. Previous settings were restored.' });
      };
      try {
        const child = spawnWorker(process.execPath, [
          fileURLToPath(new URL('./settings-apply-worker.js', import.meta.url)), paths.dataDir, id,
        ], { detached: true, windowsHide: true, stdio: 'ignore' });
        child.once('error', fail);
        if (!Number.isInteger(child.pid)) { fail(); return; }
        saveOperation(paths, { ...job, workerPid: child.pid });
        child.unref();
      } catch { fail(); }
    },
  };
}

export async function runSettingsApply(paths, id, {
  restart = restartLocalRuntime, start = startLocalRuntime, stop = stopGraphProviders,
} = {}) {
  const job = readJsonFile(operationPath(paths), null);
  if (job?.id !== id || job.status !== 'applying') return;
  const previousConfig = readJsonFile(paths.graphRuntimeConfigPath, null);
  const input = (runtimeSettings) => ({ paths, runtimeSettings,
    port: runtimeSettings.ports.console, lan: runtimeSettings.lanAccess,
    lanAccessToken: process.env.FULI_LAN_ACCESS_TOKEN, env: process.env });
  try {
    await restart(input(job.configured));
    saveOperation(paths, { ...job, status: 'applied' });
  } catch (error) {
    let rolledBack = false;
    try {
      await stop(paths, paths.graphEnvPath, { runtimeMode: job.configured.graphRuntimeMode,
        personalOnly: !(previousConfig?.workspaces ?? []).some(item => item.managedDevelopment) });
      writeRuntimeSettings(paths.runtimeSettingsPath, job.previous);
      if (previousConfig) {
        writeJsonFileAtomic(paths.graphRuntimeConfigPath, previousConfig);
        chmodSync(paths.graphRuntimeConfigPath, 0o600);
      }
      await start({ ...input(job.previous), previousRuntimeMode: job.previous.graphRuntimeMode });
      rolledBack = true;
    } catch { /* Keep the failed status; never report an unverified recovery. */ }
    saveOperation(paths, { ...job, status: 'failed', rolledBack,
      error: error instanceof Error ? error.message : 'Could not apply settings.' });
  }
}

async function checkChangedPorts(configured, previous) {
  for (const [key, port] of Object.entries(configured.ports)) {
    if (port === previous.ports[key]) continue;
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', () => reject(new TypeError(`Port ${port} is unavailable or already in use.`)));
      server.listen(port, configured.lanAccess ? '0.0.0.0' : '127.0.0.1', () => server.close(resolve));
    });
  }
}
