import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createTrustedRunner } from '../src/agent-apps/trusted-runner.js';
import {
  appRegistry, CLI_USER, events, fakeWait, latch, MANIFEST, until, verifiedApp
} from '../test-support/agent-app-hosts.js';

// rec#7 PR②b (rec#11 D-36.2): the production trusted runner end to end. Each
// test starts a trivial synthetic node script from a temporary package; the
// only processes started, probed or ended are those children, through the
// handles this test and the runner hold. No sandbox is involved, and none is claimed.

const TOOLS = ['record_decision_trace'];
const PERMISSIONS = TOOLS.map((name) => `fuli.${name}`);
// The synthetic app: reports what it was started with beside the registry,
// then stays alive until it is stopped.
const APP_SCRIPT = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const keys = Object.keys(process.env).filter((key) => key.startsWith('FULI')).sort();
const report = join(process.cwd(), '..', '..', '..', '..', 'started-' + process.env.FULI_APP_INSTANCE + '.json');
writeFileSync(report, JSON.stringify({ pid: process.pid, keys, cwd: process.cwd(), path: Boolean(process.env.PATH) }));
setInterval(() => {}, 1000);
`;
const FILES = [{ path: 'service/main.js', content: APP_SCRIPT }];

// The runner's children, and a probe that answers from their own exit status.
function trustedRunner(t) {
  const children = new Map();
  const started = [];
  const trusted = createTrustedRunner({
    spawnProcess: (...args) => {
      const child = spawn(...args);
      child.once('spawn', () => children.set(child.pid, child));
      return child;
    },
    hostIdentity: {
      identify: async (pid) => `test-child:${pid}`,
      probe: async ({ pid, identity }) => {
        const child = children.get(pid);
        if (!child || identity !== `test-child:${pid}`) return 'unknown';
        return child.exitCode !== null || child.signalCode !== null ? 'exited' : 'alive';
      }
    },
    environment: { ...process.env, FULI_SYNTHETIC_SECRET: 'not-for-apps' }
  });
  // Anything a test left running ends with it, through the handle that started it.
  t.after(async () => {
    for (const child of children.values()) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
      }
    }
  });
  // What each start was asked for, the token among it. hooks.start and
  // hooks.stop, when set, run first (and may wait or throw).
  const hooks = {};
  const runner = { ...trusted,
    start: async (spec) => { started.push(spec); await hooks.start?.(); return trusted.start(spec); },
    stop: async (handle) => { await hooks.stop?.(); return trusted.stop(handle); } };
  return { runner, children, started, hooks };
}

const childOf = (host, appId) => host.context.instances.hosted(appId)?.handle.child;
const alive = (child) => child.exitCode === null && child.signalCode === null;
const report = (registry, instanceId) => join(registry.directory, `started-${instanceId}.json`);

async function trustedHost(t, { pid = 101, ownerKind = 'console', write, wait, closeWaitMs } = {}) {
  const registry = appRegistry(t, { tools: TOOLS });
  const { runner, children, started, hooks } = trustedRunner(t);
  const hostTools = new Map([['record_decision_trace', { grantable: true, effect: 'write', scopeFields: ['personalSpaceId'],
    dataPathFields: [], marks: [], run: write ?? (async () => 'ok') }]]);
  const host = registry.host({ pid, ownerKind, runner, hostTools, wait, closeWaitMs });
  const token = () => started.at(-1).environment.FULI_APP_TOKEN;
  return { registry, host, runner, children, token, hostTools, hooks };
}

test('a confirmed app starts as a process of this account with only its FULI_APP values, and stops through its handle', async (t) => {
  const { registry, host } = await trustedHost(t);
  const app = await verifiedApp(host, { permissions: PERMISSIONS, runtime: { apiVersion: 1, entry: 'service/main.js' } }, FILES);
  const started = await host.service.start({ appId: app.appId });
  assert.equal(started.status, 'running');

  await until(() => existsSync(report(registry, started.instanceId)), 'app report');
  const reported = JSON.parse(readFileSync(report(registry, started.instanceId), 'utf8'));
  const child = childOf(host, app.appId);
  const record = host.context.store.instance(app.appId);
  assert.deepEqual([reported.pid, record.pid, record.pidIdentity], [child.pid, child.pid, `test-child:${child.pid}`]);
  assert.deepEqual(reported.keys, ['FULI_APP_ID', 'FULI_APP_INSTANCE', 'FULI_APP_TOKEN'], 'none of FULI\'s own environment');
  assert.equal(reported.path, true, 'the platform basics are kept');
  assert.equal(realpathSync(reported.cwd), realpathSync(host.context.packageOf(app.appId, '1.0.0')));
  assert.equal(host.service.read({ appId: app.appId }).run.trustMode, 'trusted');

  const stopped = await host.service.stop({ appId: app.appId });
  assert.equal(stopped.status, 'sealed');
  assert.equal(alive(child), false);
  const ended = host.context.store.instance(app.appId);
  assert.deepEqual([ended.state, ended.stopReason, Boolean(ended.stoppedAt)], ['sealed', 'stopped', true]);
  assert.equal((await host.service.start({ appId: app.appId })).generation, 2);
  await host.service.stop({ appId: app.appId });
});

test('the trusted gate still refuses an unconfirmed version and a changed package, and starts nothing', async (t) => {
  const { host, children } = await trustedHost(t);
  const submitted = await host.service.submit({ personalSpaceId: 'space-a', agentId: 'agent-jvs',
    manifest: { ...MANIFEST, runtime: { apiVersion: 1, entry: 'service/main.js' } }, files: FILES });
  assert.equal((await host.service.start({ appId: submitted.appId })).reason, 'confirmation_required');
  await host.service.approve({ appId: submitted.appId, version: '1.0.0', digest: submitted.digest,
    approver: { entrypoint: 'http', user: 'local-console' } });
  assert.equal((await host.service.start({ appId: submitted.appId })).reason, 'confirmation_required');

  const confirmed = await verifiedApp(host, { name: 'dispatch-board', runtime: { apiVersion: 1, entry: 'service/main.js' } }, FILES);
  writeFileSync(join(host.context.packageOf(confirmed.appId, '1.0.0'), 'service', 'main.js'), 'process.exit(0);\n');
  assert.equal((await host.service.start({ appId: confirmed.appId })).reason, 'challenge_mismatch');
  assert.equal(children.size, 0);
});

test('a page-only app has no process to start', async (t) => {
  const { host, children } = await trustedHost(t);
  const app = await verifiedApp(host, { runtime: { apiVersion: 1, webRoot: 'web' } },
    [{ path: 'web/index.html', content: '<h1>Synthetic page</h1>' }]);
  const started = await host.service.start({ appId: app.appId });
  assert.equal(started.status, 'running');
  assert.equal(host.context.store.instance(app.appId).pid, null);
  assert.equal(children.size, 0);
  assert.equal((await host.service.stop({ appId: app.appId })).status, 'sealed');
});

// PR② semantics with a real process: the seal waits for the write that holds
// the gate, the process keeps running until the write committed, then stops.
test('seal and drain: a write in progress finishes before the app process is stopped', async (t) => {
  const entered = latch();
  const release = latch();
  const { wait, elapse, waiting } = fakeWait();
  const { host, token: lastToken } = await trustedHost(t, { wait, write: async (_input, { dataFs }) => {
    entered.open();
    await release.promise;
    await dataFs.writeFile('notes.json', '["synthetic"]');
    return 'written';
  } });
  const app = await verifiedApp(host, { permissions: PERMISSIONS, runtime: { apiVersion: 1, entry: 'service/main.js' } }, FILES);
  await host.service.start({ appId: app.appId });
  const child = childOf(host, app.appId);
  const token = lastToken();
  const pending = host.service.callTool({ token, toolName: 'record_decision_trace', input: {} });
  await entered.promise;

  const stopping = host.service.stop({ appId: app.appId });
  await until(() => waiting() > 0, 'seal wait');
  elapse();
  await assert.rejects(stopping, { code: 'instance_sealing' });
  assert.equal(alive(child), true, 'the process runs until the write has drained');
  await assert.rejects(host.service.callTool({ token, toolName: 'record_decision_trace', input: {} }), { code: 'app_sealed' });

  release.open();
  assert.equal(await pending, 'written');
  await until(() => host.context.store.instance(app.appId).stoppedAt, 'stopped');
  assert.equal(alive(child), false);
  assert.equal(readFileSync(join(host.context.dataOf(app.appId), 'notes.json'), 'utf8'), '["synthetic"]');
  const order = events(host, app.appId).filter((action) => ['seal_waiting_for_writes', 'write_committed', 'sealed', 'stopped']
    .includes(action));
  assert.deepEqual(order, ['seal_waiting_for_writes', 'write_committed', 'sealed', 'stopped']);
});

// An exited host's app ends with the host's pipe; the next owner confirms it
// is gone before it takes over, and refuses while it still runs.
test('an orphan is never signalled: the next owner waits until the app process has ended', async (t) => {
  const { registry, host, runner } = await trustedHost(t);
  const app = await verifiedApp(host, { permissions: PERMISSIONS, runtime: { apiVersion: 1, entry: 'service/main.js' } }, FILES);
  await host.service.start({ appId: app.appId });
  const child = childOf(host, app.appId);

  registry.world.verdicts.set(101, 'exited');
  const next = registry.host({ pid: 202, ownerKind: 'cli', runner });
  await assert.rejects(next.service.disable({ appId: app.appId, actor: CLI_USER }),
    (error) => error.code === 'orphan_running' && error.detail.pid === child.pid);
  assert.equal(alive(child), true, 'the next owner never ends a process it does not hold');

  // Its host's end of the pipe closes, as it does when that FULI process exits.
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.end();
  await exited;
  await next.service.disable({ appId: app.appId, actor: CLI_USER });
  const ended = next.context.store.instance(app.appId);
  assert.deepEqual([ended.state, ended.stopReason], ['sealed', 'host_gone']);
  assert.equal(next.service.read({ appId: app.appId }).status, 'disabled');
});

// rec#10 round 2 P1: closing a FULI process ends the apps it holds, after the
// work in flight, before the registry closes; another process then owns nothing stale.
test('close admits nothing new, drains a write in flight, stops the real app process and frees its lease', async (t) => {
  const entered = latch();
  const release = latch();
  const { registry, host, token, runner, hostTools } = await trustedHost(t, { write: async (_input, { dataFs }) => {
    entered.open();
    await release.promise;
    await dataFs.writeFile('notes.json', '["before close"]');
    return 'written';
  } });
  const app = await verifiedApp(host, { permissions: PERMISSIONS, runtime: { apiVersion: 1, entry: 'service/main.js' } }, FILES);
  await host.service.start({ appId: app.appId });
  const child = childOf(host, app.appId);
  const appToken = token();
  const pending = host.service.callTool({ token: appToken, toolName: 'record_decision_trace', input: {} });
  await entered.promise;

  const closing = host.service.close();
  assert.equal(host.service.close(), closing, 'close is idempotent');
  await assert.rejects(host.service.start({ appId: app.appId }), { code: 'host_closing' });
  await assert.rejects(host.service.callTool({ token: appToken, toolName: 'record_decision_trace', input: {} }),
    { code: 'host_closing' });
  await assert.rejects(host.service.disable({ appId: app.appId, actor: CLI_USER }), { code: 'host_closing' });
  assert.equal(alive(child), true, 'the process runs until the write in flight has drained');

  release.open();
  assert.equal(await pending, 'written');
  await closing;
  assert.equal(alive(child), false);
  assert.equal(child.stdin.destroyed, true, 'the host pipe is closed');

  const next = registry.host({ pid: 102, runner, hostTools });
  const ended = next.context.store.instance(app.appId);
  assert.deepEqual([ended.state, ended.stopReason, Boolean(ended.stoppedAt)], ['sealed', 'host_closing', true]);
  assert.equal(next.context.store.owner(app.appId).ownerId, null, 'the lease is released, not left to a takeover');
  assert.equal(readFileSync(join(next.context.dataOf(app.appId), 'notes.json'), 'utf8'), '["before close"]');
  assert.deepEqual(events(next, app.appId).filter((action) => ['write_committed', 'sealed', 'stopped'].includes(action)),
    ['write_committed', 'sealed', 'stopped']);
  const restarted = await next.service.start({ appId: app.appId });
  assert.deepEqual([restarted.status, restarted.generation], ['running', 2]);
  await next.service.stop({ appId: app.appId });
});


// rec#10 round 3 item 1: a start still in flight when close gives up never
// leaves a process nobody holds.
test('a start that returns after close timed out is stopped and never registered', async (t) => {
  const { host, children, hooks } = await trustedHost(t, { closeWaitMs: 50 });
  const app = await verifiedApp(host, { runtime: { apiVersion: 1, entry: 'service/main.js' } }, FILES);
  const entered = latch();
  const resume = latch();
  hooks.start = async () => { entered.open(); await resume.promise; };
  const starting = host.service.start({ appId: app.appId });
  await entered.promise;

  await assert.rejects(host.service.close(), (error) => error.code === 'close_incomplete'
    && error.detail.startsInFlight === 1 && error.detail.notStopped.length === 0);

  resume.open();
  await assert.rejects(starting, { code: 'host_closing' });
  assert.equal(children.size, 1, 'the late start did spawn its process');
  for (const child of children.values()) assert.equal(alive(child), false, 'and it was stopped through its handle');
  assert.equal(host.context.instances.idle(), true);
  await host.service.close();
});

// rec#10 round 3 item 2: a stop that fails is reported, and its handle is kept for a retry.
test('a close whose stops fail reports the app not stopped, keeps its handle and stops it on retry', async (t) => {
  const { host, hooks } = await trustedHost(t);
  const app = await verifiedApp(host, { runtime: { apiVersion: 1, entry: 'service/main.js' } }, FILES);
  const started = await host.service.start({ appId: app.appId });
  const child = childOf(host, app.appId);
  let failures = 2;
  hooks.stop = async () => {
    if (failures > 0) {
      failures -= 1;
      throw Object.assign(new Error('synthetic stop failure'), { code: 'ESYNTH' });
    }
  };

  await assert.rejects(host.service.close(), (error) => error.code === 'close_incomplete'
    && error.detail.complete === false && error.detail.notStopped.length === 1
    && error.detail.notStopped[0].appId === app.appId && error.detail.notStopped[0].instanceId === started.instanceId
    && error.detail.notStopped[0].pid === child.pid && error.detail.notStopped[0].code === 'ESYNTH');
  assert.equal(failures, 0);
  assert.equal(alive(child), true, 'never reported as closed while it runs');
  assert.equal(host.context.instances.idle(), false, 'its handle is still held');

  await host.service.close();
  assert.equal(alive(child), false);
  assert.equal(host.context.instances.idle(), true);
});

// rec#10 round 3 item 3: an exit records its code, signal and a fixed category; no output of the app.
const EXITS = [
  ['an entry that throws while loading', `throw new Error('synthetic load failure ' + process.env.FULI_APP_TOKEN + ' in '
    + process.cwd());\n`, 1, 'load_failed'],
  ['a crash after it loaded', `setTimeout(() => { throw new Error('synthetic crash in ' + process.cwd()); }, 200);\n`, 1,
    'crashed'],
  ['a normal exit', `process.stderr.write('synthetic finished in ' + process.cwd() + '\\n');\n`, 0, 'exited']
];

for (const [label, script, code, category] of EXITS) {
  test(`${label} ends the instance as ${category}, records no app output, and the app can start again`, async (t) => {
    const { host } = await trustedHost(t);
    const app = await verifiedApp(host, { runtime: { apiVersion: 1, entry: 'service/main.js' } },
      [{ path: 'service/main.js', content: script }]);
    const first = await host.service.start({ appId: app.appId });
    await until(() => host.context.store.instance(app.appId).stoppedAt, 'the exit wrapped up');

    const { instance } = host.service.read({ appId: app.appId });
    assert.deepEqual([instance.instanceId, instance.state, instance.stopReason], [first.instanceId, 'sealed', 'app_exited']);
    assert.deepEqual(Object.keys(instance.exit).sort(), ['category', 'code', 'message', 'signal']);
    assert.deepEqual([instance.exit.code, instance.exit.category], [code, category]);
    assert.match(instance.exit.message, /^The app /);
    assert.doesNotMatch(JSON.stringify(host.context.store.events(app.appId, 1000)), /synthetic|fla_[A-Za-z0-9_-]{16,}/,
      'nothing the app wrote is recorded');
    assert.equal(host.context.store.owner(app.appId).ownerId, null);

    const again = await host.service.start({ appId: app.appId });
    assert.deepEqual([again.status, again.generation], ['running', 2]);
    await until(() => host.context.store.instance(app.appId).stoppedAt, 'the second exit wrapped up');
  });
}
