import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { claudeLifecycleUnavailable } from '../src/agents/claude-code/lifecycle-event.js';
import { consoleRecoveryNotice } from '../src/agents/lifecycle-failure.js';
import { HookInputTooLarge } from '../src/agents/lifecycle-input.js';
import { fuliNotRunning } from '../src/app/fuli-not-running.js';
import { acquireMaintenance } from '../src/data-format/maintenance-lock.js';
import { CONSOLE_AUTOSTART_LIMITS, consoleAutostart, superviseConsole } from '../src/local-runtime/console-autostart.js';
import {
  acquireConsoleStartLock,
  CONSOLE_AUTOSTART_FILE,
  readConsoleAutostart,
  recordPersonStart,
  recordPersonStop
} from '../src/local-runtime/console-autostart-record.js';
import { installedConsoleLauncher, installedConsoleTarget } from '../src/local-runtime/installed-console-launcher.js';
import { restartLocalRuntime, startLocalRuntime, stopLocalRuntime } from '../src/local-runtime/lifecycle.js';
import { fuliUnavailableGuidance, fuliUnavailableState, UNAVAILABLE_GUIDANCE_LIMIT } from '../src/local-runtime/unavailable-guidance.js';
import { startFollowerConsole } from '../src/runner/follower-console.js';
import { jsonAnswer, pairedFollower } from '../test-support/paired-follower.js';
import { installedWindowsFixture } from './fixtures/windows-installation.js';

const MINUTE = 60_000;

// A configured, synthetic data directory; nothing here reads real FULI data.
function dataDirectory(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-autostart-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeFileSync(join(dataDir, 'graph-runtime.json'), '{}');
  return dataDir;
}

// A fake runtime: a launcher that counts starts, a console that is down, a clock the test moves.
function harness(t, overrides = {}) {
  const dataDir = overrides.dataDir ?? dataDirectory(t);
  const clock = { at: Date.parse('2026-11-06T08:00:00Z') };
  const launcher = { starts: 0, start() { this.starts += 1; return true; } };
  const runtime = { state: 'down', waits: false };
  const autostart = consoleAutostart({ dataDir, launcher, now: () => clock.at,
    consoleState: async () => runtime.state, waitsForPerson: () => runtime.waits, ...overrides });
  return { dataDir, clock, launcher, runtime, autostart };
}

test('a session starts a console that is not running, once', async t => {
  const { dataDir, launcher, autostart } = harness(t);
  assert.equal(await autostart.check(), 'started');
  assert.equal(launcher.starts, 1);
  // The start in progress is not started again on the next check.
  assert.equal(await autostart.check(), 'starting');
  assert.equal(launcher.starts, 1);
  assert.equal(readConsoleAutostart(dataDir).starts.length, 1);
});

test('a console whose recorded process is gone is started on data nobody waits on', async t => {
  const dataDir = dataDirectory(t);
  writeFileSync(join(dataDir, 'graph-runtime-state.json'), JSON.stringify({ version: 4, pid: 2 ** 30, url: 'http://127.0.0.1:1' }));
  const launcher = { starts: 0, start() { this.starts += 1; } };
  assert.equal(await consoleAutostart({ dataDir, launcher }).check(), 'started');
  assert.equal(launcher.starts, 1);
});

test('a running console is left alone and nothing is written', async t => {
  const { dataDir, launcher, runtime, autostart } = harness(t);
  runtime.state = 'ready';
  assert.equal(await autostart.check(), 'running');
  assert.equal(launcher.starts, 0);
  assert.equal(existsSync(join(dataDir, CONSOLE_AUTOSTART_FILE)), false);
});

test('FULI that was never set up is not started', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-autostart-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const { launcher, autostart } = harness(t, { dataDir });
  assert.equal(await autostart.check(), 'not_configured');
  assert.equal(launcher.starts, 0);
});

test('sessions share one lock: a held lock starts nothing', async t => {
  const { dataDir, launcher, autostart } = harness(t);
  const release = acquireConsoleStartLock(dataDir);
  try {
    assert.equal(await autostart.check(), 'busy');
  } finally { release(); }
  assert.equal(launcher.starts, 0);
  assert.equal(await autostart.check(), 'started');
});

test('a start in progress, from the person or the desktop client, holds the same lock', async t => {
  const { dataDir, launcher, autostart } = harness(t);
  const paths = { dataDir, graphRuntimeConfigPath: join(dataDir, 'graph-runtime.json'),
    graphRuntimeStatePath: join(dataDir, 'graph-runtime-state.json'), graphEnvPath: join(dataDir, 'graph-provider.env') };
  let seen = null;
  await startLocalRuntime({ paths }, { readConfig: () => ({}), fileExists: () => true,
    lockStart: acquireConsoleStartLock,
    ensureRuntime: async () => { seen = await autostart.check(); return { status: 'started', url: 'http://127.0.0.1:1' }; } });
  assert.equal(seen, 'busy');
  assert.equal(launcher.starts, 0);
});

test('a second session sees the first one start and does not start again', async t => {
  const first = harness(t);
  const second = harness(t, { dataDir: first.dataDir });
  assert.equal(await first.autostart.check(), 'started');
  assert.equal(await second.autostart.check(), 'starting');
  assert.equal(first.launcher.starts + second.launcher.starts, 1);
});

test('after 3 starts in 10 minutes it gives up until the person starts FULI', async t => {
  const { dataDir, clock, launcher, autostart } = harness(t);
  for (let index = 0; index < CONSOLE_AUTOSTART_LIMITS.starts; index += 1) {
    assert.equal(await autostart.check(), 'started');
    clock.at += 3 * MINUTE;
  }
  assert.equal(await autostart.check(), 'gave_up');
  assert.equal(launcher.starts, 3);
  assert.equal(readConsoleAutostart(dataDir).held.reason, 'gave_up');
  // Given up has its own words: the Agent starts it at most once, then reports instead of starting it again.
  assert.equal(fuliUnavailableState(dataDir), 'gave_up');
  assert.match(fuliUnavailableGuidance(dataDir), /Run `fuli start` at most once; if it stops again, run `fuli status` \(and `fuli diagnostics` if needed\).*do not start it again.*最多运行一次 `fuli start`/);
  // Not retried forever: the window passing does not start it again.
  clock.at += 60 * MINUTE;
  assert.equal(await autostart.check(), 'gave_up');
  assert.equal(launcher.starts, 3);
  recordPersonStart(dataDir);
  assert.equal(await autostart.check(), 'started');
});

test('starts spread beyond the window never add up to giving up', async t => {
  const { clock, launcher, autostart } = harness(t);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(await autostart.check(), 'started');
    clock.at += 6 * MINUTE;
  }
  assert.equal(launcher.starts, 5);
});

test('a console the person stopped is not started again, by any session', async t => {
  const { dataDir, launcher, autostart } = harness(t);
  recordPersonStop(dataDir);
  assert.equal(await autostart.check(), 'stopped_by_person');
  assert.equal(launcher.starts, 0);
  assert.equal(fuliUnavailableState(dataDir), 'stopped_by_person');
});

test('a stop the person makes while a session decides wins over that session', async t => {
  const dataDir = dataDirectory(t);
  const { launcher, autostart } = harness(t, { dataDir, waitsForPerson: () => { recordPersonStop(dataDir); return false; } });
  assert.equal(await autostart.check(), 'stopped_by_person');
  assert.equal(launcher.starts, 0);
});

test('data waiting for the person is not started, and says so', async t => {
  const { dataDir, launcher, runtime, autostart } = harness(t);
  runtime.waits = true;
  assert.equal(await autostart.check(), 'needs_person');
  assert.equal(launcher.starts, 0);
  assert.match(fuliUnavailableGuidance(dataDir), /data format update waits for the person/);
  runtime.waits = false;
  assert.equal(await autostart.check(), 'started');
  assert.equal(fuliUnavailableState(dataDir), 'not_running');
});

test('fuli stop records the intent and fuli start clears it; an automatic start yields to it', async t => {
  const dataDir = dataDirectory(t);
  const paths = { dataDir, graphRuntimeConfigPath: join(dataDir, 'graph-runtime.json'),
    graphRuntimeStatePath: join(dataDir, 'graph-runtime-state.json'), graphEnvPath: join(dataDir, 'graph-provider.env') };
  const stopped = await stopLocalRuntime({ paths }, { readConfig: () => null, readState: () => null, fileExists: () => false });
  assert.equal(stopped.status, 'stopped');
  assert.ok(readConsoleAutostart(dataDir).stoppedAt);

  let started = 0;
  const startDeps = { readConfig: () => ({}), fileExists: () => true,
    ensureRuntime: async () => { started += 1; return { status: 'started', url: 'http://127.0.0.1:1' }; },
    readAutostart: readConsoleAutostart, recordStart: recordPersonStart };
  await assert.rejects(startLocalRuntime({ paths, automatic: true }, startDeps), /stopped on purpose/);
  assert.equal(started, 0);
  await startLocalRuntime({ paths }, startDeps);
  assert.equal(started, 1);
  assert.equal(readConsoleAutostart(dataDir).stoppedAt, null);
});

test('the task entry\'s unavailable text says which case it is and what the Agent may do', async t => {
  const dataDir = dataDirectory(t);
  const runtimeConfigPath = join(dataDir, 'graph-runtime.json');
  const unavailable = () => claudeLifecycleUnavailable('UserPromptSubmit', null, null, '', consoleRecoveryNotice(runtimeConfigPath))
    .systemMessage;
  assert.match(unavailable(), /^Fuli context is unavailable;.*FULI is not running\. Run `fuli start`, then `fuli status`/);
  recordPersonStop(dataDir);
  assert.match(unavailable(), /The person stopped FULI\. If this task needs it, run `fuli start`.*你之前停了 FULI，这个任务需要它，我已经重新启动/);
  assert.doesNotMatch(unavailable(), /stopped on purpose|not started automatically/);
  // A console process that is alive but does not answer: busy, never restarted.
  writeFileSync(join(dataDir, 'graph-runtime-state.json'), JSON.stringify({ version: 4, pid: process.pid, url: 'http://127.0.0.1:1' }));
  recordPersonStart(dataDir);
  assert.match(unavailable(), /this computer is busy\. Do not restart it; carry on with this turn.*电脑很忙，FULI 应答慢。不要重启/);
  // A start under way holds the start lock: wait, do not start it again.
  const release = acquireConsoleStartLock(dataDir);
  try { assert.match(unavailable(), /FULI is starting or restarting.*do not start it again.*正在启动或重启/); }
  finally { release(); }
  // A call the console refused: nothing listens, so a live PID is no busy console.
  const refused = claudeLifecycleUnavailable('UserPromptSubmit', null, null, '',
    consoleRecoveryNotice(runtimeConfigPath, fuliNotRunning())).systemMessage;
  assert.match(refused, /FULI is not running\. Run `fuli start`/);
  assert.doesNotMatch(refused, /busy|Do not restart|电脑很忙/);
  assert.equal(fuliUnavailableState(dataDir, { refused: true }), 'not_running');
  assert.equal(consoleRecoveryNotice(null), '');
  // A hook that failed on its own input says nothing of FULI.
  assert.equal(consoleRecoveryNotice(runtimeConfigPath, new SyntaxError('synthetic')), '');
  assert.equal(consoleRecoveryNotice(runtimeConfigPath, new HookInputTooLarge('synthetic')), '');
});

test('every case of the guidance stays short and forbids the person\'s data operations', () => {
  const states = { not_running: {}, stopped_by_person: {}, busy: { isAlive: () => true },
    starting: { startUnderWay: () => true }, maintenance: { maintenanceUnderWay: () => true } };
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-guidance-'));
  try {
    for (const [state, dependencies] of Object.entries(states)) {
      if (state === 'stopped_by_person') recordPersonStop(dataDir);
      writeFileSync(join(dataDir, 'graph-runtime-state.json'), JSON.stringify({ pid: 7 }));
      assert.equal(fuliUnavailableState(dataDir, { isAlive: () => false, ...dependencies }), state);
      const text = fuliUnavailableGuidance(dataDir, { isAlive: () => false, ...dependencies });
      assert.ok(text.length <= UNAVAILABLE_GUIDANCE_LIMIT, `${state}: ${text.length} characters`);
      assert.match(text, /Never run fuli graph import\/export\/migrate\/abandon-import or fuli graph runtime recover\/unlock/);
      assert.match(text, /不结束 Neo4j/);
    }
    recordPersonStart(dataDir);
    writeFileSync(join(dataDir, CONSOLE_AUTOSTART_FILE), JSON.stringify({ version: 1, stoppedAt: null, starts: [],
      held: { reason: 'data_format', at: '2026-11-06T08:00:00Z' } }));
    const waiting = fuliUnavailableGuidance(dataDir);
    assert.ok(waiting.length <= UNAVAILABLE_GUIDANCE_LIMIT);
    assert.match(waiting, /data format update waits for the person/);
    writeFileSync(join(dataDir, CONSOLE_AUTOSTART_FILE), JSON.stringify({ version: 1, stoppedAt: null, starts: [],
      held: { reason: 'gave_up', at: '2026-11-06T08:00:00Z' } }));
    assert.equal(fuliUnavailableState(dataDir, { isAlive: () => false }), 'gave_up');
    const gaveUp = fuliUnavailableGuidance(dataDir, { isAlive: () => false });
    assert.ok(gaveUp.length <= UNAVAILABLE_GUIDANCE_LIMIT, `gave_up: ${gaveUp.length} characters`);
    assert.match(gaveUp, /不结束 Neo4j/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
  assert.equal(fuliUnavailableGuidance(join(tmpdir(), 'fuli-guidance-missing')), '');
});

test('a restart holds the start lock instead of recording that the person stopped FULI', async t => {
  const dataDir = dataDirectory(t);
  const paths = { dataDir, graphRuntimeConfigPath: join(dataDir, 'graph-runtime.json'),
    graphRuntimeStatePath: join(dataDir, 'graph-runtime-state.json'), graphEnvPath: join(dataDir, 'graph-provider.env') };
  const seen = [];
  const lockStart = () => acquireConsoleStartLock(dataDir);
  const deps = { readConfig: () => ({}), readState: () => null, fileExists: () => false,
    recordStop: recordPersonStop, recordStart: recordPersonStart, readAutostart: readConsoleAutostart, lockStart,
    ensureRuntime: async () => {
      seen.push({ stoppedAt: readConsoleAutostart(dataDir).stoppedAt, state: fuliUnavailableState(dataDir) });
      return { status: 'started', url: 'http://127.0.0.1:1' };
    } };
  const restarted = await restartLocalRuntime({ paths }, deps);
  assert.equal(restarted.status, 'restarted');
  assert.deepEqual(seen, [{ stoppedAt: null, state: 'starting' }]);
  assert.equal(readConsoleAutostart(dataDir).stoppedAt, null);

  // A restart whose start fails leaves nothing that keeps sessions from starting FULI again.
  await assert.rejects(restartLocalRuntime({ paths }, { ...deps, ensureRuntime: async () => { throw new Error('synthetic'); } }),
    /synthetic/);
  assert.equal(readConsoleAutostart(dataDir).stoppedAt, null);
  assert.equal(fuliUnavailableState(dataDir), 'not_running');
  const launcher = { starts: 0, start() { this.starts += 1; } };
  assert.equal(await consoleAutostart({ dataDir, launcher, consoleState: async () => 'down', waitsForPerson: () => false }).check(),
    'started');

  // Only the person's own stop records it.
  await stopLocalRuntime({ paths }, deps);
  assert.ok(readConsoleAutostart(dataDir).stoppedAt);
});

test('supervising checks soon after the session starts and then on a schedule, until stopped', async t => {
  const dataDir = dataDirectory(t);
  const timers = [];
  const launcher = { starts: 0, start() { this.starts += 1; } };
  const stop = superviseConsole({ dataDir, env: {}, launcher, consoleState: async () => 'down', waitsForPerson: () => false,
    setTimer: (callback, delayMs) => { const timer = { callback, delayMs, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; } });
  assert.equal(timers[0].delayMs, CONSOLE_AUTOSTART_LIMITS.firstCheckMs);
  await timers[0].callback();
  assert.equal(launcher.starts, 1);
  assert.equal(timers[1].delayMs, CONSOLE_AUTOSTART_LIMITS.checkEveryMs);
  stop();
  assert.equal(timers[1].cleared, true);
});

test('nothing is supervised when it is switched off or the package is not installed', async t => {
  const dataDir = dataDirectory(t);
  const setTimer = () => assert.fail('no check may be scheduled');
  superviseConsole({ dataDir, env: { FULI_CONSOLE_AUTOSTART: 'off' }, launcher: { start() {} }, setTimer })();
  superviseConsole({ dataDir, env: {}, launcher: null, setTimer })();
});

test('only an installed FULI is started, never a source checkout', async () => {
  const dataDir = join(tmpdir(), 'fuli-autostart-data');
  assert.equal(installedConsoleTarget({ dataDir, packageRoot: join(tmpdir(), 'checkout', 'fuli'), platform: 'linux',
    execPath: 'node' }), null);
  // A path that looks like FULI.app but has no bundled runtime is not one (whether or not this computer has FULI.app).
  assert.equal(installedConsoleTarget({ dataDir, packageRoot: join(tmpdir(), 'fuli-no-app', 'FULI.app', 'Contents',
    'Resources', 'fuli'),
    platform: 'darwin', execPath: 'node' }), null);
  const npmRoot = join(tmpdir(), 'lib', 'node_modules', 'fuli-context');
  assert.deepEqual(installedConsoleTarget({ dataDir, packageRoot: npmRoot, platform: 'linux', execPath: 'node-bin' })(),
    { command: 'node-bin', cli: join(npmRoot, 'src', 'cli.js'), cwd: npmRoot });
});

test('the Windows installation record names the package that is started, for its own data only', async t => {
  const f = installedWindowsFixture(t);
  const { packageRoot, dataDir } = f.current;
  const target = installedConsoleTarget({ dataDir, packageRoot, platform: 'win32', execPath: 'node' });
  assert.deepEqual(target(), { command: join(packageRoot, 'runtime', 'node', 'node.exe'),
    cli: join(packageRoot, 'src', 'cli.js'), cwd: packageRoot });
  mkdirSync(join(f.root, 'other-data'));
  assert.equal(installedConsoleTarget({ dataDir: join(f.root, 'other-data'), packageRoot, platform: 'win32',
    execPath: 'node' }), null);
});

test('the console is started detached, as an automatic start of the same data', async () => {
  const npmRoot = join(tmpdir(), 'lib', 'node_modules', 'fuli-context');
  const dataDir = join(tmpdir(), 'fuli-autostart-data');
  const spawned = [];
  const launcher = installedConsoleLauncher({ dataDir, packageRoot: npmRoot, platform: 'linux', execPath: 'node-bin',
    env: { SYNTHETIC: '1' }, spawnProcess: (command, args, options) => {
      spawned.push({ command, args, options });
      return { on() {}, unref() { spawned.at(-1).unref = true; } };
    } });
  assert.equal(launcher.start(), true);
  assert.deepEqual(spawned[0].args, [join(npmRoot, 'src', 'cli.js'), 'start', '--data-dir', dataDir, '--automatic']);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.stdio, 'ignore');
  assert.equal(spawned[0].unref, true);
});

test('a console alive without answering is started again once it has not answered for a while (rec#94)', async t => {
  const { clock, launcher, runtime, autostart } = harness(t);
  runtime.state = 'unanswered';
  assert.equal(await autostart.check(), 'unanswered');
  clock.at += CONSOLE_AUTOSTART_LIMITS.checkEveryMs;
  assert.equal(await autostart.check(), 'unanswered');
  assert.equal(launcher.starts, 0);
  clock.at += CONSOLE_AUTOSTART_LIMITS.stuckMs;
  // The start replaces the stuck process (unresponsive-console.js).
  assert.equal(await autostart.check(), 'started');
  assert.equal(launcher.starts, 1);
});

test('a busy console that answers again in time is left alone, and its wait starts over', async t => {
  const { clock, launcher, runtime, autostart } = harness(t);
  runtime.state = 'unanswered';
  assert.equal(await autostart.check(), 'unanswered');
  clock.at += CONSOLE_AUTOSTART_LIMITS.stuckMs - 1;
  runtime.state = 'ready';
  assert.equal(await autostart.check(), 'running');
  runtime.state = 'unanswered';
  clock.at += CONSOLE_AUTOSTART_LIMITS.checkEveryMs;
  assert.equal(await autostart.check(), 'unanswered');
  assert.equal(launcher.starts, 0);
});

test('a refused console is replaced after the old short wait, a slow one only after the long one', async t => {
  const refused = harness(t);
  refused.runtime.state = 'refused';
  assert.equal(await refused.autostart.check(), 'unanswered');
  refused.clock.at += CONSOLE_AUTOSTART_LIMITS.refusedMs - 1;
  assert.equal(await refused.autostart.check(), 'unanswered');
  refused.clock.at += 1;
  assert.equal(await refused.autostart.check(), 'started');
  assert.equal(CONSOLE_AUTOSTART_LIMITS.refusedMs, 40_000);

  const slow = harness(t);
  slow.runtime.state = 'unanswered';
  assert.equal(await slow.autostart.check(), 'unanswered');
  slow.clock.at += CONSOLE_AUTOSTART_LIMITS.refusedMs;
  assert.equal(await slow.autostart.check(), 'unanswered');
  slow.clock.at += CONSOLE_AUTOSTART_LIMITS.stuckMs - CONSOLE_AUTOSTART_LIMITS.refusedMs;
  assert.equal(await slow.autostart.check(), 'started');
  assert.equal(slow.launcher.starts, 1);
});

test('a whole-store restore holding the data says FULI waits for the person and is not to be started', async t => {
  const dataDir = dataDirectory(t);
  const release = acquireMaintenance(dataDir);
  try {
    assert.equal(fuliUnavailableState(dataDir), 'maintenance');
    assert.match(fuliUnavailableGuidance(dataDir),
      /Do not run `fuli start`.*FULI is waiting for you to handle something; do not start it yet.*FULI 在等你处理一件事，先不要启动/);
  } finally { release(); }
  assert.equal(fuliUnavailableState(dataDir), 'not_running');
});

test('an unanswering console the person stopped on purpose is still not started', async t => {
  const { dataDir, clock, launcher, runtime, autostart } = harness(t);
  runtime.state = 'unanswered';
  recordPersonStop(dataDir);
  assert.equal(await autostart.check(), 'unanswered');
  clock.at += CONSOLE_AUTOSTART_LIMITS.stuckMs;
  assert.equal(await autostart.check(), 'stopped_by_person');
  assert.equal(launcher.starts, 0);
});

// A synthetic console on an ephemeral loopback port, recorded with this test's own PID.
async function recordedConsole(t, dataDir, answer) {
  const server = createServer((request, response) => answer(response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  writeFileSync(join(dataDir, 'graph-runtime-state.json'), JSON.stringify({ version: 4, pid: process.pid,
    url: `http://127.0.0.1:${server.address().port}` }));
}

test('a recorded console whose address refuses is replaced after the short wait, one that answers wrongly is not', async t => {
  const clock = { at: Date.parse('2026-11-06T08:00:00Z') };
  const launcher = { starts: 0, start() { this.starts += 1; } };
  const refusing = dataDirectory(t);
  const closed = createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  writeFileSync(join(refusing, 'graph-runtime-state.json'), JSON.stringify({ version: 4, pid: process.pid,
    url: `http://127.0.0.1:${port}` }));
  const refused = consoleAutostart({ dataDir: refusing, launcher, now: () => clock.at, waitsForPerson: () => false });
  assert.equal(await refused.check(), 'unanswered');
  clock.at += CONSOLE_AUTOSTART_LIMITS.refusedMs;
  assert.equal(await refused.check(), 'started');

  const answering = dataDirectory(t);
  await recordedConsole(t, answering, response => { response.statusCode = 503; response.end(); });
  const slow = consoleAutostart({ dataDir: answering, launcher, now: () => clock.at, waitsForPerson: () => false });
  assert.equal(await slow.check(), 'unanswered');
  clock.at += CONSOLE_AUTOSTART_LIMITS.refusedMs;
  assert.equal(await slow.check(), 'unanswered');
  assert.equal(launcher.starts, 1);
});

test('a recorded console counts as running only when it answers as itself', async t => {
  const answering = dataDirectory(t);
  await recordedConsole(t, answering, response => response.end(JSON.stringify({ service: 'fuli-local-console', pid: process.pid })));
  const launcher = { starts: 0, start() { this.starts += 1; } };
  assert.equal(await consoleAutostart({ dataDir: answering, launcher, waitsForPerson: () => false }).check(), 'running');

  const silent = dataDirectory(t);
  await recordedConsole(t, silent, response => { response.statusCode = 503; response.end(); });
  assert.equal(await consoleAutostart({ dataDir: silent, launcher, waitsForPerson: () => false }).check(), 'unanswered');
  assert.equal(launcher.starts, 0);
});

// A follower that owns a project records its own console (runner/follower-runtime-broker.js): that
// console answers for itself at its status path, while its /api/health is the host's, carried over the pairing.
test('a session beside a follower’s own console keeps it as running, and starts it again only once it is gone', async t => {
  const follower = await pairedFollower(t, { localAnswer: () => jsonAnswer({ status: 'available' }) });
  const { dataDir, served, client } = follower;
  served.routes.setLocalProject('project:widgets', follower.projectPath);
  served.routes.replicaSynced('global', '2026-11-06T08:00:00Z');
  const localRead = () => client.callTool({ name: 'fuli_call', arguments: {
    toolName: 'search_current_project_knowledge', input: { personalProjectId: 'widgets' } } });
  assert.equal((await localRead()).structuredContent.status, 'available');

  follower.hostAway();
  // The host is away. Its discovery path cannot answer a liveness check on this computer.
  let probes = 0;
  const consoleEntry = await startFollowerConsole({ port: 0, dataDir, store: served.store,
    projectIds: () => ['widgets'], connection: { hello: async () => { probes += 1; throw Error('host unavailable'); } } });
  try {
    const url = consoleEntry.url;
    const state = join(dataDir, 'graph-runtime-state.json');
    writeFileSync(join(dataDir, 'graph-runtime.json'), '{}');
    writeFileSync(state, JSON.stringify({ version: 4, pid: process.pid, url, follower: true }));
    const clock = { at: Date.parse('2026-11-06T08:00:00Z') };
    const launcher = { starts: 0, start() { this.starts += 1; } };
    const autostart = consoleAutostart({ dataDir, launcher, now: () => clock.at, waitsForPerson: () => false });
    // An MCP session open for 12 minutes, checking as superviseConsole does.
    for (const end = clock.at + 12 * MINUTE; clock.at < end; clock.at += CONSOLE_AUTOSTART_LIMITS.checkEveryMs) {
      assert.equal(await autostart.check(), 'running');
    }
    assert.equal(launcher.starts, 0);
    const record = readConsoleAutostart(dataDir);
    assert.deepEqual(record.starts, []);
    assert.equal(record.held ?? null, null, 'never gave up');
    assert.equal(probes, 0, 'the health check completed entirely on this computer');
    assert.equal((await localRead()).structuredContent.status, 'available', 'same MCP session still serves its project');
    assert.equal(follower.local.opened.length, 1);
    // The follower's console process ended without clearing its address: started again at once.
    writeFileSync(state, JSON.stringify({ version: 4, pid: 2 ** 30, url, follower: true }));
    assert.equal(await autostart.check(), 'started');
    assert.equal(launcher.starts, 1);
  } finally { await consoleEntry.close(); }
});
