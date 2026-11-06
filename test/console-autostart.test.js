import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claudeLifecycleUnavailable } from '../src/agents/claude-code/lifecycle-hook.js';
import { consoleRecoveryNotice } from '../src/agents/lifecycle-failure.js';
import { CONSOLE_AUTOSTART_LIMITS, consoleAutostart, superviseConsole } from '../src/local-runtime/console-autostart.js';
import {
  acquireConsoleStartLock,
  CONSOLE_AUTOSTART_FILE,
  consoleAutostartNotice,
  readConsoleAutostart,
  recordPersonStart,
  recordPersonStop
} from '../src/local-runtime/console-autostart-record.js';
import { installedConsoleLauncher, installedConsoleTarget } from '../src/local-runtime/installed-console-launcher.js';
import { startLocalRuntime, stopLocalRuntime } from '../src/local-runtime/lifecycle.js';
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
  const runtime = { running: false, waits: false };
  const autostart = consoleAutostart({ dataDir, launcher, now: () => clock.at,
    consoleRunning: () => runtime.running, waitsForPerson: () => runtime.waits, ...overrides });
  return { dataDir, clock, launcher, runtime, autostart };
}

test('a session starts a console that is not running, once', t => {
  const { dataDir, launcher, autostart } = harness(t);
  assert.equal(autostart.check(), 'started');
  assert.equal(launcher.starts, 1);
  // The start in progress is not started again on the next check.
  assert.equal(autostart.check(), 'starting');
  assert.equal(launcher.starts, 1);
  assert.equal(readConsoleAutostart(dataDir).starts.length, 1);
});

test('a console whose recorded process is gone is started on data nobody waits on', t => {
  const dataDir = dataDirectory(t);
  writeFileSync(join(dataDir, 'graph-runtime-state.json'), JSON.stringify({ version: 4, pid: 2 ** 30, url: 'http://127.0.0.1:1' }));
  const launcher = { starts: 0, start() { this.starts += 1; } };
  assert.equal(consoleAutostart({ dataDir, launcher }).check(), 'started');
  assert.equal(launcher.starts, 1);
});

test('a running console is left alone and nothing is written', t => {
  const { dataDir, launcher, runtime, autostart } = harness(t);
  runtime.running = true;
  assert.equal(autostart.check(), 'running');
  assert.equal(launcher.starts, 0);
  assert.equal(existsSync(join(dataDir, CONSOLE_AUTOSTART_FILE)), false);
});

test('FULI that was never set up is not started', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-autostart-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const { launcher, autostart } = harness(t, { dataDir });
  assert.equal(autostart.check(), 'not_configured');
  assert.equal(launcher.starts, 0);
});

test('sessions share one lock: a held lock starts nothing', t => {
  const { dataDir, launcher, autostart } = harness(t);
  const release = acquireConsoleStartLock(dataDir);
  try {
    assert.equal(autostart.check(), 'busy');
  } finally { release(); }
  assert.equal(launcher.starts, 0);
  assert.equal(autostart.check(), 'started');
});

test('a start in progress, from the person or the desktop client, holds the same lock', async t => {
  const { dataDir, launcher, autostart } = harness(t);
  const paths = { dataDir, graphRuntimeConfigPath: join(dataDir, 'graph-runtime.json'),
    graphRuntimeStatePath: join(dataDir, 'graph-runtime-state.json'), graphEnvPath: join(dataDir, 'graph-provider.env') };
  let seen = null;
  await startLocalRuntime({ paths }, { readConfig: () => ({}), fileExists: () => true,
    lockStart: acquireConsoleStartLock,
    ensureRuntime: async () => { seen = autostart.check(); return { status: 'started', url: 'http://127.0.0.1:1' }; } });
  assert.equal(seen, 'busy');
  assert.equal(launcher.starts, 0);
});

test('a second session sees the first one start and does not start again', t => {
  const first = harness(t);
  const second = harness(t, { dataDir: first.dataDir });
  assert.equal(first.autostart.check(), 'started');
  assert.equal(second.autostart.check(), 'starting');
  assert.equal(first.launcher.starts + second.launcher.starts, 1);
});

test('after 3 starts in 10 minutes it gives up until the person starts FULI', t => {
  const { dataDir, clock, launcher, autostart } = harness(t);
  for (let index = 0; index < CONSOLE_AUTOSTART_LIMITS.starts; index += 1) {
    assert.equal(autostart.check(), 'started');
    clock.at += 3 * MINUTE;
  }
  assert.equal(autostart.check(), 'gave_up');
  assert.equal(launcher.starts, 3);
  assert.equal(readConsoleAutostart(dataDir).held.reason, 'gave_up');
  assert.match(consoleAutostartNotice(dataDir), /stopped starting itself after 3 automatic starts in 10 minutes/);
  // Not retried forever: the window passing does not start it again.
  clock.at += 60 * MINUTE;
  assert.equal(autostart.check(), 'gave_up');
  assert.equal(launcher.starts, 3);
  recordPersonStart(dataDir);
  assert.equal(consoleAutostartNotice(dataDir), '');
  assert.equal(autostart.check(), 'started');
});

test('starts spread beyond the window never add up to giving up', t => {
  const { clock, launcher, autostart } = harness(t);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(autostart.check(), 'started');
    clock.at += 6 * MINUTE;
  }
  assert.equal(launcher.starts, 5);
});

test('a console the person stopped is not started again, by any session', t => {
  const { dataDir, launcher, autostart } = harness(t);
  recordPersonStop(dataDir);
  assert.equal(autostart.check(), 'stopped_by_person');
  assert.equal(launcher.starts, 0);
  assert.match(consoleAutostartNotice(dataDir), /stopped on purpose/);
});

test('a stop the person makes while a session decides wins over that session', t => {
  const dataDir = dataDirectory(t);
  const { launcher, autostart } = harness(t, { dataDir, waitsForPerson: () => { recordPersonStop(dataDir); return false; } });
  assert.equal(autostart.check(), 'stopped_by_person');
  assert.equal(launcher.starts, 0);
});

test('data waiting for the person is not started, and says so', t => {
  const { dataDir, launcher, runtime, autostart } = harness(t);
  runtime.waits = true;
  assert.equal(autostart.check(), 'needs_person');
  assert.equal(launcher.starts, 0);
  assert.match(consoleAutostartNotice(dataDir), /data format update waits for the person/);
  runtime.waits = false;
  assert.equal(autostart.check(), 'started');
  assert.equal(consoleAutostartNotice(dataDir), '');
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

test('the task entry\'s unavailable text says why FULI is not started', t => {
  const dataDir = dataDirectory(t);
  const runtimeConfigPath = join(dataDir, 'graph-runtime.json');
  assert.equal(consoleRecoveryNotice(runtimeConfigPath), '');
  recordPersonStop(dataDir);
  const recovery = consoleRecoveryNotice(runtimeConfigPath);
  const output = claudeLifecycleUnavailable('UserPromptSubmit', null, null, '', recovery);
  assert.match(output.systemMessage, /^Fuli context is unavailable;.*stopped on purpose/);
  assert.equal(consoleRecoveryNotice(null), '');
});

test('supervising checks soon after the session starts and then on a schedule, until stopped', t => {
  const dataDir = dataDirectory(t);
  const timers = [];
  const launcher = { starts: 0, start() { this.starts += 1; } };
  const stop = superviseConsole({ dataDir, env: {}, launcher, consoleRunning: () => false, waitsForPerson: () => false,
    setTimer: (callback, delayMs) => { const timer = { callback, delayMs, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; } });
  assert.equal(timers[0].delayMs, CONSOLE_AUTOSTART_LIMITS.firstCheckMs);
  timers[0].callback();
  assert.equal(launcher.starts, 1);
  assert.equal(timers[1].delayMs, CONSOLE_AUTOSTART_LIMITS.checkEveryMs);
  stop();
  assert.equal(timers[1].cleared, true);
});

test('nothing is supervised when it is switched off or the package is not installed', t => {
  const dataDir = dataDirectory(t);
  const setTimer = () => assert.fail('no check may be scheduled');
  superviseConsole({ dataDir, env: { FULI_CONSOLE_AUTOSTART: 'off' }, launcher: { start() {} }, setTimer })();
  superviseConsole({ dataDir, env: {}, launcher: null, setTimer })();
});

test('only an installed FULI is started, never a source checkout', () => {
  const dataDir = join(tmpdir(), 'fuli-autostart-data');
  assert.equal(installedConsoleTarget({ dataDir, packageRoot: join(tmpdir(), 'checkout', 'fuli'), platform: 'linux',
    execPath: 'node' }), null);
  // A path that looks like FULI.app but has no bundled runtime is not one.
  assert.equal(installedConsoleTarget({ dataDir, packageRoot: '/Applications/FULI.app/Contents/Resources/fuli',
    platform: 'darwin', execPath: 'node' }), null);
  const npmRoot = join(tmpdir(), 'lib', 'node_modules', 'fuli-context');
  assert.deepEqual(installedConsoleTarget({ dataDir, packageRoot: npmRoot, platform: 'linux', execPath: 'node-bin' })(),
    { command: 'node-bin', cli: join(npmRoot, 'src', 'cli.js'), cwd: npmRoot });
});

test('the Windows installation record names the package that is started, for its own data only', t => {
  const f = installedWindowsFixture(t);
  const { packageRoot, dataDir } = f.current;
  const target = installedConsoleTarget({ dataDir, packageRoot, platform: 'win32', execPath: 'node' });
  assert.deepEqual(target(), { command: join(packageRoot, 'runtime', 'node', 'node.exe'),
    cli: join(packageRoot, 'src', 'cli.js'), cwd: packageRoot });
  mkdirSync(join(f.root, 'other-data'));
  assert.equal(installedConsoleTarget({ dataDir: join(f.root, 'other-data'), packageRoot, platform: 'win32',
    execPath: 'node' }), null);
});

test('the console is started detached, as an automatic start of the same data', () => {
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
