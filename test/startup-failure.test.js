import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { followStageMarkers, runTrayAction } from '../src/desktop/desktop-controller.js';
import {
  formatStartupFailure,
  readStartupFailureMarker,
  reportingStartupFailure,
  STARTUP_FAILURE_CODES,
  startupFailureMarker,
  startupFailureOf
} from '../src/local-runtime/startup-failure.js';
import { STAGE_MARKER_ENV } from '../src/local-runtime/startup-stage.js';
import { assertMacNativePortFree, elapsedSeconds } from '../src/native-runtime/macos-ports.js';
import {
  acquireNeo4jLifecycleLock,
  neo4jLifecycleLockError,
  readNeo4jLifecycleLock,
  releaseAbandonedNeo4jLifecycleLock,
  withNativeAssetOperation
} from '../src/native-runtime/neo4j-asset-state.js';

const runtimeDir = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

// A lock as a start killed before this change left it: an owner token, no holder.
function oldStyleLock(root) {
  mkdirSync(join(root, '.neo4j-lifecycle.lock'), { recursive: true });
  writeFileSync(join(root, '.neo4j-lifecycle.lock', 'owner'), 'token-a');
}

test('every failure says what happened and the next step, in both languages', () => {
  const facts = { since: '2026-11-22T17:24:35.000Z', pid: 4321, holderRunning: false, lockPath: '/x/.neo4j-lifecycle.lock',
    port: 7687, command: 'java', runningSeconds: 30_000, seconds: 60, logPath: '/x/logs/runtime.log' };
  for (const code of STARTUP_FAILURE_CODES) {
    const text = formatStartupFailure({ ...facts, code });
    const lines = text.split('\n');
    assert.equal(lines.length, 4, code);
    assert.match(lines[0], /^没有启动：/);
    assert.match(lines[1], /^下一步：/);
    assert.match(lines[2], /^FULI did not start: /);
    assert.match(lines[3], /^Next: /);
  }
});

test('the port holder is named with how long it has run', () => {
  const text = formatStartupFailure({ code: 'port_taken', port: 7687, pid: 4321, command: 'java', runningSeconds: 8 * 3600 + 5 });
  assert.match(text, /端口 7687 被另一个程序占着（进程 4321 · java，已运行 8 小时）/);
  assert.match(text, /Port 7687 is held by another program \(process 4321 · java, running for 8 h\)/);
  assert.equal(elapsedSeconds('08:00:05'), 8 * 3600 + 5);
  assert.equal(elapsedSeconds('1-00:00:00'), 86_400);
});

test('a lock nobody holds any more and a lock with a running holder read differently', () => {
  const orphan = formatStartupFailure({ code: 'native_lifecycle_lock', since: '2026-11-22T17:24:35.000Z', pid: null,
    holderRunning: false, lockPath: '/x/.neo4j-lifecycle.lock' });
  assert.match(orphan, /没有记录是谁加的/);
  assert.match(orphan, /删掉 \/x\/\.neo4j-lifecycle\.lock 再启动/);
  const held = formatStartupFailure({ code: 'native_lifecycle_lock', since: '2026-11-22T17:24:35.000Z', pid: 4321,
    holderRunning: true, lockPath: '/x/.neo4j-lifecycle.lock' });
  assert.match(held, /进程 4321 还在用它/);
  assert.match(held, /等进程 4321 结束后再启动/);
});

test('an error a person cannot act on keeps its own message', async () => {
  assert.equal(startupFailureOf(new Error('something else')), null);
  await assert.rejects(reportingStartupFailure(async () => { throw new Error('something else'); }, { write: () => {}, env: {} }),
    /^Error: something else$/);
});

test('a known failure is printed as two parts, and as a line only for a client reading along', async () => {
  const failing = async () => { throw Object.assign(new Error('Graphiti provider did not become ready'), { code: 'provider_not_ready' }); };
  const quiet = [];
  await assert.rejects(reportingStartupFailure(failing, { write: line => quiet.push(line), env: {}, logPath: '/x/logs/runtime.log' }),
    (error) => {
      assert.match(error.message, /^没有启动：Provider 启动后一直没有就绪。\n下一步：再运行一次同样的命令重试。启动日志在 \/x\/logs\/runtime\.log。/);
      assert.deepEqual(error.startupFailure, { code: 'provider_not_ready', logPath: '/x/logs/runtime.log' });
      return true;
    });
  assert.deepEqual(quiet, []);
  const lines = [];
  await assert.rejects(reportingStartupFailure(failing, { write: line => lines.push(line), env: { [STAGE_MARKER_ENV]: '1' } }));
  assert.deepEqual(readStartupFailureMarker(lines[0]), { code: 'provider_not_ready', logPath: null });
  // A result line is never read as a failure line.
  assert.equal(readStartupFailureMarker(JSON.stringify({ ok: false, failure: { code: 'provider_not_ready' } })), null);
  assert.equal(readStartupFailureMarker(startupFailureMarker({ code: 'made_up' })), null);
});

test('the controller passes the failure the start reported on to its client', async () => {
  const result = await runTrayAction('start', { packageRoot: '/x/pkg', dataDir: '/x/data', nodePath: '/x/node', cliPath: '/x/cli.js' }, {
    runCli: async (_context, args, onStage, onFailure) => {
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ status: 'stopped' }), stderr: '' };
      onStage('graph_start');
      onFailure({ code: 'port_taken', port: 7687, pid: 4321, command: 'java', runningSeconds: 60 });
      return { code: 1, stdout: '', stderr: '没有启动：端口 7687 被另一个程序占着' };
    },
    portBlocked: async () => false, otherConsole: () => null, holdAdoption: () => null
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failure, { code: 'port_taken', port: 7687, pid: 4321, command: 'java', runningSeconds: 60 });
  const stream = new PassThrough();
  const failures = [];
  followStageMarkers(stream, () => {}, failure => failures.push(failure));
  stream.write(`${startupFailureMarker({ code: 'console_exited', logPath: '/x/log' })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failures, [{ code: 'console_exited', logPath: '/x/log' }]);
});

test('a lock records its holder, and one whose holder has ended is taken over', async (t) => {
  const root = runtimeDir(t);
  const lock = await acquireNeo4jLifecycleLock(root);
  assert.equal(readNeo4jLifecycleLock(root).pid, process.pid);
  // Its holder still runs: it stays.
  assert.equal(releaseAbandonedNeo4jLifecycleLock(root, { isAlive: () => true }), false);
  assert.ok(existsSync(join(root, '.neo4j-lifecycle.lock')));
  // Its holder has ended (a start that was killed): released.
  assert.equal(releaseAbandonedNeo4jLifecycleLock(root, { isAlive: () => false }), true);
  assert.equal(readNeo4jLifecycleLock(root), null);
  await assert.rejects(lock.release());
});

test('a start after a killed one takes over the abandoned lock and runs', async (t) => {
  const root = runtimeDir(t);
  await acquireNeo4jLifecycleLock(root);
  const ran = await withNativeAssetOperation({ nativeRuntimeDir: root }, {}, async () => 'started', { isAlive: () => false });
  assert.equal(ran, 'started');
  assert.equal(readNeo4jLifecycleLock(root), null, 'the start released the lock it took');
});

test('a lock that names no holder, or a transaction waiting for recovery, is left for a person and reported', async (t) => {
  const root = runtimeDir(t);
  oldStyleLock(root);
  assert.equal(releaseAbandonedNeo4jLifecycleLock(root, { isAlive: () => false }), false);
  await assert.rejects(withNativeAssetOperation({ nativeRuntimeDir: root }, {}, async () => 'started', { isAlive: () => false }),
    (error) => {
      assert.equal(error.code, 'native_lifecycle_lock');
      assert.equal(error.startupFailure.holderRunning, false);
      assert.equal(error.startupFailure.pid, null);
      assert.ok(error.startupFailure.since);
      assert.equal(error.startupFailure.lockPath, join(root, '.neo4j-lifecycle.lock'));
      return true;
    });
  const recovering = runtimeDir(t);
  await acquireNeo4jLifecycleLock(recovering);
  writeFileSync(join(recovering, 'neo4j-transaction.json'), '{}');
  assert.equal(releaseAbandonedNeo4jLifecycleLock(recovering, { isAlive: () => false }), false);
  assert.equal(neo4jLifecycleLockError(recovering, { isAlive: () => true }).startupFailure.holderRunning, true);
});

test('a port another program holds is reported with that program, and nothing is signalled', async () => {
  await assertMacNativePortFree(7687, { listeners: async () => [] });
  await assert.rejects(assertMacNativePortFree(7687, {
    listeners: async () => [4321], describe: async () => ({ command: 'java', runningSeconds: 120 })
  }), (error) => {
    assert.match(error.message, /Native service port 7687 is already in use; its owner was left untouched/);
    assert.deepEqual(error.startupFailure, { code: 'port_taken', port: 7687, pid: 4321, command: 'java', runningSeconds: 120 });
    return true;
  });
});

test('a stopped FULI whose automatic restarts gave up says so in its status', async () => {
  const { inspectLocalRuntime } = await import('../src/local-runtime/lifecycle.js');
  const paths = { dataDir: '/x/data', graphRuntimeConfigPath: '/x/data/graph-runtime.json',
    graphRuntimeStatePath: '/x/data/graph-runtime-state.json' };
  const deps = (held, stoppedAt = null) => ({
    readConfig: () => ({ personal: { providerUrl: 'http://127.0.0.1:8787' }, workspaces: [] }), readState: () => null,
    isProcessAlive: () => false, consoleHealth: async () => false, providerHealth: async url => ({ url, status: 'ready' }),
    readAutostart: () => ({ stoppedAt, starts: ['a', 'b', 'c'], held })
  });
  const gaveUp = await inspectLocalRuntime({ paths, port: 2727 }, deps({ reason: 'gave_up', at: '2026-11-22T18:05:25.972Z' }));
  assert.deepEqual(gaveUp.autostart, { gaveUp: true, at: '2026-11-22T18:05:25.972Z', starts: 3 });
  // Stopped on purpose, or not held: nothing to say.
  assert.equal((await inspectLocalRuntime({ paths, port: 2727 }, deps({ reason: 'gave_up', at: 'x' }, 'y'))).autostart, undefined);
  assert.equal((await inspectLocalRuntime({ paths, port: 2727 }, deps(null))).autostart, undefined);
});
