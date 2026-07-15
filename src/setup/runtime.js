import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync
} from 'node:fs';
import { dirname } from 'node:path';

import { openLocalApplication } from '../runtime-options.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

export function buildServerInvocation({
  paths,
  nodePath = process.execPath,
  personalSpaceName,
  port
}) {
  return {
    command: nodePath,
    args: [
      paths.serverPath,
      '--db', paths.dbPath,
      '--personal-space', personalSpaceName,
      '--port', String(port)
    ]
  };
}

export async function ensureLocalRuntime(input, dependencies = {}) {
  const deps = runtimeDependencies(dependencies);
  initializeDatabase(input, deps.openApplication);
  if (input.noStart) return { status: 'initialized', url: null, pid: null };

  const existing = deps.readState(input.paths.statePath);
  const existingAlive = ownsRuntime(existing, input) && deps.isProcessAlive(existing.pid);
  if (existingAlive) {
    if (typeof existing.url === 'string' && await deps.healthCheck(existing.url, existing.pid)) {
      return { status: 'running', url: existing.url, pid: existing.pid };
    }
    throw new Error(`Recorded Fuli runtime is not healthy. See ${input.paths.logPath}`);
  }

  const url = `http://127.0.0.1:${input.port}`;
  const child = deps.spawnRuntime({
    paths: input.paths,
    nodePath: process.execPath,
    personalSpaceName: input.personalSpaceName,
    port: input.port
  });
  if (!Number.isInteger(child?.pid)) {
    throw new Error(`Fuli runtime could not start. See ${input.paths.logPath}`);
  }
  if (!await deps.healthCheck(url, child.pid) || !deps.isProcessAlive(child.pid)) {
    deps.stopProcess(child.pid);
    throw new Error(`Fuli runtime did not become healthy. See ${input.paths.logPath}`);
  }

  const state = {
    version: 1,
    pid: child.pid,
    url,
    dbPath: input.paths.dbPath,
    personalSpaceName: input.personalSpaceName,
    port: input.port,
    startedAt: deps.now().toISOString()
  };
  try {
    deps.writeState(input.paths.statePath, state);
  } catch (error) {
    deps.stopProcess(child.pid);
    throw error;
  }
  return { status: 'started', url, pid: child.pid };
}

function initializeDatabase(input, openApplication) {
  const app = openApplication({
    dbPath: input.paths.dbPath,
    personalSpaceName: input.personalSpaceName
  });
  app.close();
}

function ownsRuntime(state, input) {
  return state?.version === 1 &&
    state.dbPath === input.paths.dbPath &&
    state.personalSpaceName === input.personalSpaceName &&
    Number.isInteger(state.pid);
}

function runtimeDependencies(overrides) {
  return {
    openApplication: openLocalApplication,
    readState: readRuntimeState,
    writeState: writeRuntimeState,
    spawnRuntime,
    isProcessAlive,
    healthCheck: waitForHealth,
    stopProcess,
    now: () => new Date(),
    ...overrides
  };
}

function spawnRuntime(input) {
  mkdirSync(dirname(input.paths.logPath), { recursive: true });
  const log = openSync(input.paths.logPath, 'a');
  try {
    const invocation = buildServerInvocation(input);
    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log]
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

function readRuntimeState(path) {
  try {
    return readJsonFile(path, null);
  } catch {
    return null;
  }
}

function writeRuntimeState(path, state) {
  writeJsonFileAtomic(path, state);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // The process may have exited while the health check was running.
  }
}

async function waitForHealth(url, pid) {
  let consecutiveSuccesses = 0;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (Number.isInteger(pid) && !isProcessAlive(pid)) return false;
    try {
      const response = await fetch(`${url}/api/state`);
      consecutiveSuccesses = response.ok ? consecutiveSuccesses + 1 : 0;
      if (consecutiveSuccesses >= 2) return true;
    } catch {
      consecutiveSuccesses = 0;
      // Startup races are expected until the listener is ready.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}
