import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runTrayAction } from '../src/desktop/desktop-controller.js';
import { processState } from '../src/local-runtime/processes.js';
import { lockReleaseRefusal, reportingStartupFailure } from '../src/local-runtime/startup-failure.js';
import { readStartupFailure, startupFailureLine } from '../src/local-runtime/startup-failure-line.js';
import { assertMacNativePortFree } from '../src/native-runtime/macos-ports.js';
import { withNativeAssetOperation } from '../src/native-runtime/neo4j-asset-state.js';
import {
  acquireNeo4jLifecycleLock,
  neo4jLifecycleLockError,
  releaseAbandonedNeo4jLifecycleLock,
  releaseStaleNeo4jLifecycleLock
} from '../src/native-runtime/neo4j-lifecycle-lock.js';

const LOCK = '.neo4j-lifecycle.lock';

// What the terminal prints for a failure a start names.
async function formatStartupFailure(failure) {
  try {
    await reportingStartupFailure(async () => { throw Object.assign(new Error('raw'), { startupFailure: failure }); });
  } catch (error) { return error.message; }
  throw new Error('the start did not fail');
}

function runtimeDir(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// How a recorded holder looks to `ps`, without asking the system.
const holderGone = { state: () => 'gone', startTime: async () => null, matches: async () => false };
const holderRunning = { state: () => 'running', startTime: async () => 'Sun Nov 22 01:24:35 2026', matches: async () => true };
// The PID runs again, but it is another program started later: the holder is gone.
const pidReused = { state: () => 'running', startTime: async () => 'Mon Nov 23 09:00:00 2026', matches: async () => false };
// Another user's process (EPERM) with the recorded start time: still the holder.
const otherUser = { state: () => 'other_user', startTime: async () => 'Sun Nov 22 01:24:35 2026', matches: async () => true };
const holderIdentity = async () => ({ pid: 4321, command: 'node /x/cli.js start', startedAt: 'Sun Nov 22 01:24:35 2026' });

// A lock as a start killed before FULI recorded holders left it: a token, no holder.
function oldStyleLock(root, { ageMinutes = 0 } = {}) {
  mkdirSync(join(root, LOCK), { recursive: true });
  writeFileSync(join(root, LOCK, 'owner'), 'token-a');
  const at = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(join(root, LOCK), at, at);
}

test('only ESRCH means a process is gone; another user\'s process (EPERM) still runs', () => {
  const failing = code => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(processState(4321, { signal: () => {} }), 'running');
  assert.equal(processState(4321, { signal: failing('EPERM') }), 'other_user');
  assert.equal(processState(4321, { signal: failing('ESRCH') }), 'gone');
  assert.equal(processState(-1), 'gone');
});

test('a lock records who took it and for what, and appears whole', async (t) => {
  const root = runtimeDir(t);
  const lock = await acquireNeo4jLifecycleLock(root, { operation: 'start', identify: holderIdentity });
  assert.deepEqual(readdirSync(root).filter(name => name.startsWith(LOCK)), [LOCK], 'no prepared directory is left behind');
  await assert.rejects(acquireNeo4jLifecycleLock(root, { operation: 'start', identify: holderIdentity }), /lock exists/);
  await lock.release();
  assert.equal(existsSync(join(root, LOCK)), false);
});

test('a start\'s lock whose holder ended, or whose PID now runs another program, is taken over', async (t) => {
  for (const identity of [holderGone, pidReused]) {
    const root = runtimeDir(t);
    await acquireNeo4jLifecycleLock(root, { operation: 'start', identify: holderIdentity });
    assert.equal(await releaseAbandonedNeo4jLifecycleLock(root, identity), true);
    assert.equal(existsSync(join(root, LOCK)), false);
  }
});

test('a holder that still runs keeps its lock, also when it is another user\'s process', async (t) => {
  for (const identity of [holderRunning, otherUser]) {
    const root = runtimeDir(t);
    await acquireNeo4jLifecycleLock(root, { operation: 'start', identify: holderIdentity });
    assert.equal(await releaseAbandonedNeo4jLifecycleLock(root, identity), false);
    assert.equal((await neo4jLifecycleLockError(root, identity)).startupFailure.holder, 'running');
  }
});

test('a lock an update, rollback or uninstall left is never taken over', async (t) => {
  for (const operation of ['update', 'rollback', 'uninstall']) {
    const root = runtimeDir(t);
    await acquireNeo4jLifecycleLock(root, { operation, identify: holderIdentity });
    assert.equal(await releaseAbandonedNeo4jLifecycleLock(root, holderGone), false);
    const failure = (await neo4jLifecycleLockError(root, holderGone)).startupFailure;
    assert.deepEqual([failure.holder, failure.operation], ['gone', operation]);
    assert.deepEqual(await releaseStaleNeo4jLifecycleLock({ paths: { nativeRuntimeDir: root }, identity: holderGone }),
      { released: false, reason: 'asset_operation', operation });
  }
});

test('two starts taking over the same lock: one removes it, the other leaves the new one alone', async (t) => {
  const root = runtimeDir(t);
  await acquireNeo4jLifecycleLock(root, { operation: 'start', identify: holderIdentity });
  const results = await Promise.all([releaseAbandonedNeo4jLifecycleLock(root, holderGone), releaseAbandonedNeo4jLifecycleLock(root, holderGone)]);
  assert.deepEqual(results.sort(), [false, true]);
  // The winner takes a new lock; a late taker that judged the old one must not remove it.
  const fresh = await acquireNeo4jLifecycleLock(root, { operation: 'start', identify: holderIdentity });
  assert.equal(await releaseAbandonedNeo4jLifecycleLock(root, holderRunning), false);
  await fresh.assertHeld();
  await fresh.release();
});

test('a start after a killed one takes over the abandoned lock and runs', async (t) => {
  const root = runtimeDir(t);
  await acquireNeo4jLifecycleLock(root, { operation: 'start', identify: holderIdentity });
  const ran = await withNativeAssetOperation({ nativeRuntimeDir: root }, {}, async () => 'started', { identity: holderGone });
  assert.equal(ran, 'started');
  assert.equal(existsSync(join(root, LOCK)), false, 'the start released the lock it took');
});

test('a holder gone with a switch journal waiting: recovery, never a reason to remove the lock', async (t) => {
  const root = runtimeDir(t);
  await acquireNeo4jLifecycleLock(root, { operation: 'update', identify: holderIdentity });
  writeFileSync(join(root, 'neo4j-transaction.json'), JSON.stringify({ action: 'update', phase: 'switching' }));
  assert.equal(await releaseAbandonedNeo4jLifecycleLock(root, holderGone), false);
  await assert.rejects(withNativeAssetOperation({ nativeRuntimeDir: root }, {}, async () => 'started', { identity: holderGone }),
    (error) => {
      assert.equal(error.code, 'native_recovery_needed');
      assert.deepEqual([error.startupFailure.operation, error.startupFailure.phase], ['update', 'switching']);
      return true;
    });
  const text = await formatStartupFailure((await neo4jLifecycleLockError(root, holderGone)).startupFailure);
  assert.match(text, /有一次数据库更新没做完/);
  assert.match(text, /知识数据还在原来的位置/);
  assert.match(text, /不要删除数据库维护锁或 neo4j-transaction\.json/);
  assert.doesNotMatch(text, /unlock|删掉|没有记录是谁加的/);
  assert.equal((await releaseStaleNeo4jLifecycleLock({ paths: { nativeRuntimeDir: root }, identity: holderGone })).reason, 'recovery_needed');
});

test('the three holders of a lock read differently, each with its own next step', async () => {
  const base = { code: 'native_lifecycle_lock', since: '2026-11-22T17:24:35.000Z', pid: 4321, lockPath: '/x/native-runtime/.neo4j-lifecycle.lock' };
  const running = await formatStartupFailure({ ...base, holder: 'running', command: 'node' });
  assert.match(running, /被进程 4321（node）占着/);
  assert.match(running, /等进程 4321 结束后再启动/);
  const gone = await formatStartupFailure({ ...base, holder: 'gone', operation: 'update' });
  assert.match(gone, /一次数据库更新在 .* 中途停了/);
  assert.match(gone, /\/x\/native-runtime\/neo4j-assets/);
  assert.doesNotMatch(gone, /unlock/);
  const unknown = await formatStartupFailure({ ...base, holder: 'unknown' });
  assert.match(unknown, /没有记录是谁加的/);
  assert.match(unknown, /fuli graph runtime unlock/);
});

function releaseCase(t, { ageMinutes = 120, processes = [], recorded = {}, identity = holderGone } = {}) {
  const root = runtimeDir(t);
  oldStyleLock(root, { ageMinutes });
  writeFileSync(join(root, 'processes.json'), JSON.stringify(recorded));
  const paths = { dataDir: '/x/fuli-data', nativeRuntimeDir: root, nativeProcessStatePath: join(root, 'processes.json') };
  return { root, run: () => releaseStaleNeo4jLifecycleLock({ paths, identity, listProcesses: async () => processes }) };
}

test('an old lock nobody recorded is released only when every check passes, and says which one did not', async (t) => {
  const released = releaseCase(t);
  assert.deepEqual(await released.run(), { released: true });
  assert.equal(existsSync(join(released.root, LOCK)), false);

  assert.equal((await releaseCase(t, { ageMinutes: 30 }).run()).reason, 'too_recent');
  // A graph service processes.json records still runs as itself.
  const serviceRuns = { ...holderGone, state: pid => pid === 77 ? 'running' : 'gone', matches: async pid => pid === 77 };
  assert.deepEqual(await releaseCase(t, { recorded: { databases: { personal: { pid: 77, command: 'java' } } }, identity: serviceRuns }).run(),
    { released: false, reason: 'services_running', pid: 77 });
  const other = releaseCase(t, { processes: [{ pid: 88, command: 'node /opt/fuli/src/cli.js start --data-dir /x/fuli-data' }] });
  assert.deepEqual(await other.run(), { released: false, reason: 'fuli_running', pid: 88 });
  // The console and an Agent's MCP process name the data too, but take no lock.
  const quiet = releaseCase(t, { processes: [{ pid: 89, command: 'node /opt/fuli/src/mcp-server.js --runtime-config /x/fuli-data/graph-runtime.json' }] });
  assert.equal((await quiet.run()).released, true);
  const blind = releaseCase(t);
  blind.run = () => releaseStaleNeo4jLifecycleLock({ paths: { dataDir: '/x/fuli-data', nativeRuntimeDir: blind.root,
    nativeProcessStatePath: join(blind.root, 'processes.json') }, identity: holderGone, listProcesses: async () => null });
  assert.equal((await blind.run()).reason, 'cannot_inspect');
  assert.match(lockReleaseRefusal({ reason: 'fuli_running', pid: 88 }), /另一个 FULI 命令（进程 88）正在用这份数据/);
});

test('the window\'s 解除这把锁并启动 releases first and starts only then; a kept lock says why', async () => {
  const context = { packageRoot: '/x/pkg', dataDir: '/x/fuli-test-data-that-does-not-exist', nodePath: '/x/node', cliPath: '/x/cli.js' };
  const calls = [];
  const runCli = async (_context, args) => {
    calls.push(args[0]);
    return args[0] === 'status' ? { code: 0, stdout: JSON.stringify({ status: 'stopped' }), stderr: '' } : { code: 0, stdout: '', stderr: '' };
  };
  const kept = await runTrayAction('release-lock-start', context, { runCli,
    releaseLock: async () => ({ released: false, reason: 'too_recent', releasableAt: '2026-11-23T03:00:00.000Z' }) });
  assert.equal(kept.ok, false);
  assert.equal(kept.lockRelease.reason, 'too_recent');
  assert.ok(!calls.includes('setup') && !calls.includes('start'), 'nothing started while the lock stays');
});

test('every failure says what happened and the next step, in both languages', async () => {
  const facts = { since: '2026-11-22T17:24:35.000Z', pid: 4321, holder: 'unknown', lockPath: '/x/.neo4j-lifecycle.lock',
    port: 7687, command: 'java', runningSeconds: 30_000, seconds: 60, logPath: '/x/logs/runtime.log' };
  for (const code of ['native_recovery_needed', 'native_lifecycle_lock', 'port_taken', 'console_not_answering', 'console_exited',
    'console_port_reserved', 'provider_not_ready', 'provider_exited']) {
    const lines = (await formatStartupFailure({ ...facts, code })).split('\n');
    assert.equal(lines.length, 4, code);
    assert.match(lines[0], /^没有启动：/);
    assert.match(lines[1], /^下一步：/);
    assert.match(lines[2], /^FULI did not start: /);
    assert.match(lines[3], /^Next: /);
  }
});

test('the port holder is named with how long it has run', async () => {
  assert.match(await formatStartupFailure({ code: 'port_taken', port: 7687, pid: 4321, command: 'java', runningSeconds: 8 * 3600 + 5 }),
    /端口 7687 被另一个程序占着（进程 4321 · java，已运行 8 小时）/);
  await assertMacNativePortFree(7687, { listeners: async () => [] });
  await assert.rejects(assertMacNativePortFree(7687, {
    listeners: async () => [4321], describe: async () => ({ command: 'java', runningSeconds: 120 })
  }), (error) => {
    assert.deepEqual(error.startupFailure, { code: 'port_taken', port: 7687, pid: 4321, command: 'java', runningSeconds: 120 });
    return true;
  });
});

test('a known failure is printed as two parts; its reason crosses to a client on its own line, without local paths', async () => {
  await assert.rejects(reportingStartupFailure(async () => { throw new Error('something else'); }), /^Error: something else$/);
  const failing = async () => {
    throw Object.assign(new Error('lock'), { code: 'native_lifecycle_lock', startupFailure: {
      code: 'native_lifecycle_lock', holder: 'unknown', since: '2026-11-22T17:24:35.000Z', lockPath: '/x/.neo4j-lifecycle.lock' } });
  };
  await assert.rejects(reportingStartupFailure(failing, { logPath: '/x/logs/runtime.log' }), (error) => {
    assert.match(error.message, /^没有启动：数据库维护锁/);
    assert.deepEqual(error.startupFailure, { code: 'native_lifecycle_lock', holder: 'unknown', since: '2026-11-22T17:24:35.000Z' });
    const line = startupFailureLine(error);
    assert.deepEqual(readStartupFailure(`${error.message}\n${line}`), { failure: error.startupFailure, stderr: error.message });
    return true;
  });
});

test('the controller passes the reason the CLI printed on to its client', async () => {
  const result = await runTrayAction('start', { packageRoot: '/x/pkg', dataDir: '/x/fuli-test-data-that-does-not-exist', nodePath: '/x/node', cliPath: '/x/cli.js' }, {
    runCli: async (_context, args) => {
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ status: 'stopped' }), stderr: '' };
      return { code: 1, stdout: '', stderr: `没有启动：端口 7687 被另一个程序占着\n${startupFailureLine({ startupFailure: { code: 'port_taken', port: 7687, pid: 4321 } })}` };
    },
    portBlocked: async () => false, otherConsole: () => null, holdAdoption: () => null
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failure, { code: 'port_taken', port: 7687, pid: 4321 });
  assert.equal(result.error, '没有启动：端口 7687 被另一个程序占着');
});

test('a stopped FULI whose automatic restarts gave up says so in its status', async () => {
  const { inspectLocalRuntime } = await import('../src/local-runtime/lifecycle.js');
  const paths = { dataDir: '/x/data', graphRuntimeConfigPath: '/x/data/graph-runtime.json', graphRuntimeStatePath: '/x/data/graph-runtime-state.json' };
  const deps = (held, stoppedAt = null) => ({
    readConfig: () => ({ personal: { providerUrl: 'http://127.0.0.1:8787' }, workspaces: [] }), readState: () => null,
    isProcessAlive: () => false, consoleHealth: async () => false, providerHealth: async url => ({ url, status: 'ready' }),
    readAutostart: () => ({ stoppedAt, starts: ['a', 'b', 'c'], held })
  });
  const gaveUp = await inspectLocalRuntime({ paths, port: 2727 }, deps({ reason: 'gave_up', at: '2026-11-22T18:05:25.972Z' }));
  assert.deepEqual(gaveUp.autostart, { gaveUp: true, at: '2026-11-22T18:05:25.972Z', starts: 3 });
  assert.equal((await inspectLocalRuntime({ paths, port: 2727 }, deps({ reason: 'gave_up', at: 'x' }, 'y'))).autostart, undefined);
  assert.equal((await inspectLocalRuntime({ paths, port: 2727 }, deps(null))).autostart, undefined);
});

test('fuli graph runtime unlock runs the same checks and says why it kept the lock', async () => {
  const { runNativeRuntimeCommand } = await import('../src/cli/native-runtime-command.js');
  const written = [];
  const deps = (result) => ({ platform: 'darwin', write: line => written.push(line),
    resolvePaths: () => ({ dataDir: '/x/fuli-data', nativeRuntimeDir: '/x/fuli-data/native-runtime' }), releaseLock: async () => result });
  assert.deepEqual(await runNativeRuntimeCommand(['unlock', '--yes'], deps({ released: true })), { status: 'released', exitCode: 0 });
  const kept = await runNativeRuntimeCommand(['unlock', '--yes'], deps({ released: false, reason: 'holder_running', pid: 9 }));
  assert.deepEqual(kept, { status: 'kept', reason: 'holder_running', exitCode: 1 });
  assert.match(written.at(-1), /进程 9 还在用这把锁，锁没有动/);
});
