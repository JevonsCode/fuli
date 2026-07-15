import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildServerInvocation,
  ensureLocalRuntime
} from '../src/setup/runtime.js';

const PATHS = Object.freeze({
  dataDir: 'C:/Users/Test/Fuli',
  dbPath: 'C:/Users/Test/Fuli/context.db',
  logPath: 'C:/Users/Test/Fuli/logs/runtime.log',
  statePath: 'C:/Users/Test/Fuli/runtime.json',
  serverPath: 'C:/Fuli/src/server.js'
});

test('runtime invocation passes one absolute database to the local server', () => {
  assert.deepEqual(buildServerInvocation({
    paths: PATHS,
    nodePath: 'C:/node.exe',
    personalSpaceName: 'Jevons',
    port: 5199
  }), {
    command: 'C:/node.exe',
    args: [
      PATHS.serverPath,
      '--db', PATHS.dbPath,
      '--personal-space', 'Jevons',
      '--port', '5199'
    ]
  });
});

test('no-start initializes SQLite and does not spawn a server', async () => {
  let closed = false;
  let spawned = false;
  const result = await ensureLocalRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    port: 5173,
    noStart: true
  }, {
    openApplication() {
      return { close() { closed = true; } };
    },
    spawnRuntime() {
      spawned = true;
    }
  });

  assert.equal(closed, true);
  assert.equal(spawned, false);
  assert.deepEqual(result, { status: 'initialized', url: null, pid: null });
});

test('setup reuses a healthy recorded runtime', async () => {
  const state = {
    version: 1,
    pid: 321,
    url: 'http://127.0.0.1:5173',
    dbPath: PATHS.dbPath,
    personalSpaceName: '我',
    port: 5173
  };
  let spawned = false;

  const result = await ensureLocalRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    port: 5173,
    noStart: false
  }, dependencies({
    readState: () => state,
    isProcessAlive: () => true,
    healthCheck: async () => true,
    spawnRuntime: () => { spawned = true; }
  }));

  assert.equal(spawned, false);
  assert.deepEqual(result, { status: 'running', url: state.url, pid: state.pid });
});

test('setup starts a detached runtime and records only operational metadata', async () => {
  let recorded = null;
  const result = await ensureLocalRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    port: 5173,
    noStart: false
  }, dependencies({
    readState: () => null,
    spawnRuntime(invocation) {
      assert.equal(invocation.paths, PATHS);
      return { pid: 456 };
    },
    healthCheck: async (url) => url === 'http://127.0.0.1:5173',
    writeState(path, state) {
      assert.equal(path, PATHS.statePath);
      recorded = state;
    },
    now: () => new Date('2026-07-15T04:00:00.000Z')
  }));

  assert.deepEqual(result, {
    status: 'started',
    url: 'http://127.0.0.1:5173',
    pid: 456
  });
  assert.deepEqual(recorded, {
    version: 1,
    pid: 456,
    url: 'http://127.0.0.1:5173',
    dbPath: PATHS.dbPath,
    personalSpaceName: '我',
    port: 5173,
    startedAt: '2026-07-15T04:00:00.000Z'
  });
});

test('changing setup port reuses a healthy recorded runtime without killing by stale PID',
  async () => {
  const stopped = [];
  let spawned = false;
  const previous = {
    version: 1,
    pid: 400,
    url: 'http://127.0.0.1:5173',
    dbPath: PATHS.dbPath,
    personalSpaceName: '我',
    port: 5173
  };

  const result = await ensureLocalRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    port: 5199,
    noStart: false
  }, dependencies({
    readState: () => previous,
    isProcessAlive: () => true,
    stopProcess: (pid) => stopped.push(pid),
    spawnRuntime: () => { spawned = true; return { pid: 401 }; },
    healthCheck: async () => true
  }));

  assert.deepEqual(stopped, []);
  assert.equal(spawned, false);
  assert.equal(result.pid, 400);
  assert.equal(result.url, 'http://127.0.0.1:5173');
});

test('setup stops a failed runtime and points to its log without leaking output', async () => {
  let stoppedPid = null;
  await assert.rejects(() => ensureLocalRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    port: 5173,
    noStart: false
  }, dependencies({
    readState: () => null,
    spawnRuntime: () => ({ pid: 789 }),
    healthCheck: async () => false,
    stopProcess: (pid) => { stoppedPid = pid; }
  })), new RegExp(`Fuli runtime did not become healthy.*${escapeRegex(PATHS.logPath)}`));

  assert.equal(stoppedPid, 789);
});

test('setup rejects an occupied-port health response when its new process exited', async () => {
  let stoppedPid = null;

  await assert.rejects(() => ensureLocalRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    port: 5173,
    noStart: false
  }, dependencies({
    readState: () => null,
    spawnRuntime: () => ({ pid: 800 }),
    healthCheck: async () => true,
    isProcessAlive: () => false,
    stopProcess: (pid) => { stoppedPid = pid; }
  })), new RegExp(`Fuli runtime did not become healthy.*${escapeRegex(PATHS.logPath)}`));

  assert.equal(stoppedPid, 800);
});

test('setup stops a newly started runtime when recording its state fails', async () => {
  const writeError = new Error('disk full');
  let stoppedPid = null;

  await assert.rejects(() => ensureLocalRuntime({
    paths: PATHS,
    personalSpaceName: '我',
    port: 5173,
    noStart: false
  }, dependencies({
    readState: () => null,
    spawnRuntime: () => ({ pid: 900 }),
    healthCheck: async () => true,
    writeState() { throw writeError; },
    stopProcess: (pid) => { stoppedPid = pid; }
  })), writeError);

  assert.equal(stoppedPid, 900);
});

function dependencies(overrides = {}) {
  return {
    openApplication: () => ({ close() {} }),
    readState: () => null,
    writeState() {},
    spawnRuntime: () => ({ pid: 1 }),
    isProcessAlive: () => true,
    healthCheck: async () => true,
    stopProcess() {},
    now: () => new Date(),
    ...overrides
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
