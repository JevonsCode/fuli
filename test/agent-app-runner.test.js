import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { dataDigest } from '../src/agent-apps/data-directory.js';
import {
  appRegistry, CLI_USER, countingFs, events, fakeRunner, fakeWait, FILES, latch, settle, until, verifiedApp
} from '../test-support/agent-app-hosts.js';

// rec#7 part 2 PR②: the app runner, the App Host and the serial contract.
// Synthetic only: fake host processes over one temporary registry, a fake
// runner that starts nothing, fake host tools. No app code runs.

const TOOLS = ['record_decision_trace', 'resolve_knowledge_tags'];
const PERMISSIONS = TOOLS.map((name) => `fuli.${name}`);

const writeTool = (run, extra = {}) => ({ grantable: true, effect: 'write', scopeFields: ['personalSpaceId', 'agentId'],
  dataPathFields: ['path'], marks: [], run, ...extra });
const readTool = (run) => ({ grantable: true, effect: 'read', scopeFields: ['personalSpaceId'], dataPathFields: [], marks: [], run });

async function running(t, { write = writeTool(async () => 'ok'), read = readTool(async () => 'read'), fs, wait } = {}) {
  const registry = appRegistry(t, { tools: TOOLS });
  const host = registry.host({ pid: 101, hostTools: new Map([['record_decision_trace', write], ['resolve_knowledge_tags', read]]),
    fs, wait });
  const app = await verifiedApp(host, { permissions: PERMISSIONS });
  const started = await host.service.start({ appId: app.appId });
  return { registry, host, app, started, token: lastToken(host), appId: app.appId };
}

const lastToken = (host) => host.runner.started.at(-1).environment.FULI_APP_TOKEN;
const call = (host, token, input = {}, toolName = 'record_decision_trace') => host.service.callTool({ token, toolName, input });
const instance = (host, appId) => host.context.store.instance(appId);
const ordered = (host, appId, actions) => events(host, appId).filter((action) => actions.includes(action));

test('an instance starts only past the run gate and the runner self-check, and only then gets its data root', async (t) => {
  const registry = appRegistry(t, { tools: TOOLS });
  const host = registry.host({ pid: 101 });
  const app = await verifiedApp(host);
  assert.equal(existsSync(registry.dataOf(app.appId)), false, 'approval alone creates no data directory');

  const failing = registry.host({ pid: 103, runner: fakeRunner({ selfCheck: { ok: false } }) });
  assert.equal((await failing.service.start({ appId: app.appId })).reason, 'runner_check_failed');
  assert.equal(instance(host, app.appId), null);

  const started = await host.service.start({ appId: app.appId });
  assert.deepEqual([started.status, started.generation, started.mode], ['running', 1, 'managed']);
  assert.match(started.instanceId, /^ins-[0-9a-f]{32}$/);
  assert.equal(existsSync(registry.dataOf(app.appId)), true);
  const spec = host.runner.started.at(-1);
  assert.deepEqual(Object.keys(spec.environment).sort(), ['FULI_APP_ID', 'FULI_APP_INSTANCE', 'FULI_APP_TOKEN']);
  assert.equal(host.service.read({ appId: app.appId }).instance.state, 'running');
  assert.deepEqual(host.service.read({ appId: app.appId }).owner, { ownerKind: 'console', pid: 101,
    since: '2026-10-24T08:00:00.000Z', heartbeatAt: '2026-10-24T08:00:00.000Z' });
  await assert.rejects(host.service.start({ appId: app.appId }), { code: 'instance_running' });

  const stopped = await host.service.stop({ appId: app.appId });
  assert.equal(stopped.status, 'sealed');
  const ended = instance(host, app.appId);
  assert.deepEqual([ended.state, ended.stopReason, Boolean(ended.sealedAt)], ['sealed', 'stopped', true]);
  assert.equal(host.context.store.owner(app.appId).ownerId, null);
  assert.deepEqual(ordered(host, app.appId, ['instance_started', 'stopping', 'sealed', 'stopped']),
    ['instance_started', 'stopping', 'sealed', 'stopped']);
  assert.equal((await host.service.start({ appId: app.appId })).generation, 2);
});

test('an app token verifies only for the current running instance this process hosts', async (t) => {
  const { host, appId, token, registry } = await running(t);
  assert.equal(await call(host, token), 'ok');
  await assert.rejects(call(host, token, {}, 'list_project_agents'), { code: 'tool_not_permitted' });

  const other = registry.host({ pid: 102, hostTools: host.context.hostTools() });
  await assert.rejects(other.service.callTool({ token, toolName: 'record_decision_trace', input: {} }),
    { code: 'instance_superseded' });

  await host.service.stop({ appId });
  await assert.rejects(call(host, token), { code: 'app_token_invalid' });
  await host.service.start({ appId });
  await assert.rejects(call(host, token), { code: 'app_token_invalid' });
  assert.equal(await call(host, lastToken(host)), 'ok');
  await assert.rejects(call(host, `fla_${'A'.repeat(43)}`), { code: 'app_token_invalid' });
});

// rec#10 PR312 round 2 P2: an exit is bound to the instance it was started for.
test('an exit reported for an earlier instance never touches the current one', async (t) => {
  const { host, appId } = await running(t);
  const first = host.runner.started.at(-1);
  await host.service.stop({ appId });
  const second = await host.service.start({ appId });

  first.onExit({ code: 1, signal: null, category: 'crashed' });
  await settle();
  await settle();
  assert.deepEqual([instance(host, appId).instanceId, instance(host, appId).state], [second.instanceId, 'running']);
  assert.equal(events(host, appId).includes('app_exited'), false);

  // Its own exit ends it, once, even when reported twice.
  const current = host.runner.started.at(-1);
  current.onExit({ code: 0, signal: null, category: 'exited' });
  current.onExit({ code: 0, signal: null, category: 'exited' });
  await until(() => instance(host, appId).stoppedAt, 'the current exit wrapped up');
  assert.deepEqual([instance(host, appId).stopReason, events(host, appId).filter((action) => action === 'app_exited').length],
    ['app_exited', 1]);
  assert.equal((await host.service.start({ appId })).generation, 3);
});

test('a decision seals and stops the running instance first, and its tokens end with it', async (t) => {
  const { host, appId, token, registry } = await running(t);
  const entry = join(registry.root, 'packages', appId, '1.0.0', 'service', 'main.js');
  writeFileSync(entry, 'process.exit(1);\n');
  await assert.rejects(call(host, token), { code: 'package_tampered' });
  writeFileSync(entry, FILES[0].content);
  await assert.rejects(call(host, token), { code: 'app_token_invalid' }, 'a tampered package ends its tokens');

  await host.service.disable({ appId, actor: CLI_USER });
  assert.deepEqual([instance(host, appId).state, instance(host, appId).stopReason], ['sealed', 'disable']);
  await host.decisions.rollback({ appId, version: '1.0.0', actor: CLI_USER });
  await host.service.start({ appId });
  const second = lastToken(host);
  await host.service.deleteCode({ appId, actor: CLI_USER });
  assert.equal(instance(host, appId).stopReason, 'deleteCode');
  await assert.rejects(call(host, second), { code: 'app_token_invalid' });
});

test('scope fields are refused when they differ, never silently replaced, then injected', async (t) => {
  const seen = [];
  const { host, appId, token } = await running(t, { write: writeTool(async (input) => { seen.push(input); return 'ok'; }) });

  await call(host, token, { personalSpaceId: 'space-a', note: 'synthetic' });
  await call(host, token, {});
  assert.deepEqual(seen, [{ personalSpaceId: 'space-a', agentId: 'agent-jvs', note: 'synthetic' },
    { personalSpaceId: 'space-a', agentId: 'agent-jvs' }]);
  await assert.rejects(call(host, token, { personalSpaceId: 'space-b' }),
    (error) => error.code === 'scope_violation' && error.status === 403 && error.detail.field === 'personalSpaceId');
  await assert.rejects(call(host, token, { path: '../other-app/notes.json' }),
    (error) => error.code === 'scope_violation' && error.detail.field === 'path');
  assert.equal(seen.length, 2, 'a refused call never reaches the tool');
  assert.equal(instance(host, appId).state, 'running');

  // The third refusal within ten minutes seals the instance.
  await assert.rejects(call(host, token, { agentId: 'agent-dot' }), { code: 'scope_violation' });
  await until(() => instance(host, appId).state === 'sealed', 'sealed after three violations');
  assert.equal(instance(host, appId).stopReason, 'scope_violations');
  assert.equal(events(host, appId).filter((action) => action === 'scope_violation').length, 3);
});

test('a marked or unknown tool is refused at the host even when a tool map offers it', async (t) => {
  const registry = appRegistry(t, { tools: TOOLS });
  const marked = { ...writeTool(async () => 'sent'), marks: ['egress'] };
  const host = registry.host({ pid: 101, hostTools: new Map([['record_decision_trace', marked]]) });
  const app = await verifiedApp(host, { permissions: PERMISSIONS });
  await host.service.start({ appId: app.appId });
  await assert.rejects(call(host, lastToken(host)), { code: 'tool_not_permitted' });
  await assert.rejects(call(host, lastToken(host), {}, 'resolve_knowledge_tags'), { code: 'tool_not_permitted' });
});

// D-28.17 T1: a write tool holds the gate when the instance is stopped.
test('T1 sealing waits for a write in progress, refuses decisions meanwhile and completes after it', async (t) => {
  const entered = latch();
  const release = latch();
  const { wait, elapse, waiting } = fakeWait();
  const { host, appId, token } = await running(t, { wait, write: writeTool(async (_input, { dataFs }) => {
    entered.open();
    await release.promise;
    await dataFs.writeFile('notes.json', '["synthetic"]');
    return 'written';
  }) });
  const pending = call(host, token);
  await entered.promise;

  const stopping = host.service.stop({ appId });
  await until(() => waiting() > 0, 'seal wait');
  elapse();
  await assert.rejects(stopping, (error) => error.code === 'instance_sealing' && error.detail.waitingFor === 'record_decision_trace');
  assert.equal(instance(host, appId).state, 'sealing');
  assert.equal(host.service.list({}).apps[0].instance.waitingFor.toolName, 'record_decision_trace');
  await assert.rejects(host.service.disable({ appId, actor: CLI_USER }), { code: 'instance_sealing' });
  await assert.rejects(call(host, token), { code: 'app_sealed' });

  release.open();
  assert.equal(await pending, 'written');
  await until(() => instance(host, appId).stoppedAt, 'stopped');
  assert.deepEqual(ordered(host, appId, ['seal_waiting_for_writes', 'write_committed', 'sealed']),
    ['seal_waiting_for_writes', 'write_committed', 'sealed']);
  assert.equal(readFileSync(join(host.context.dataOf(appId), 'notes.json'), 'utf8'), '["synthetic"]');
  assert.equal(host.context.store.owner(appId).ownerId, null);
});

// D-28.17 T2: a write authorized before the seal reaches the gate after the data is gone.
test('T2 a write queued behind the seal and the data deletion is fenced and never recreates the data root', async (t) => {
  const counting = countingFs();
  const ran = [];
  const { host, appId, token } = await running(t, { fs: counting.fs,
    write: writeTool(async (_input, { dataFs }) => { ran.push('tool'); await dataFs.mkdir('logs'); }) });
  const late = host.service.authorizeCall({ token, toolName: 'record_decision_trace', input: {} });

  await host.service.stop({ appId });
  await host.service.deleteCode({ appId, actor: CLI_USER });
  const offer = await host.service.prepareDataDeletion({ appId });
  await host.service.deleteData({ appId, ticket: offer.ticket, confirm: appId, actor: CLI_USER });

  await assert.rejects(late.run(), { code: 'instance_superseded' });
  assert.deepEqual(ran, []);
  assert.deepEqual(counting.calls, []);
  const data = host.context.dataOf(appId);
  assert.equal(existsSync(data), false);
  assert.deepEqual(readdirSync(dirname(data)).filter((name) => name.startsWith(`${appId}.deleting-`)), []);
  assert.equal(events(host, appId).at(-1), 'write_fenced');
});

// D-28.17 T3: the same, with a new activation (generation + 1) in between.
test('T3 a write of a superseded instance is refused and the new instance data is unchanged', async (t) => {
  const { host, appId, token } = await running(t, { write: writeTool(async (_input, { dataFs }) => {
    await dataFs.writeFile('notes.json', 'from the old instance');
  }) });
  const late = host.service.authorizeCall({ token, toolName: 'record_decision_trace', input: {} });
  await host.service.stop({ appId });
  assert.equal((await host.service.start({ appId })).generation, 2);
  const before = await dataDigest(host.context.dataOf(appId));

  await assert.rejects(late.run(), { code: 'instance_superseded' });
  assert.deepEqual(await dataDigest(host.context.dataOf(appId)), before);
  assert.equal(instance(host, appId).state, 'running');
});

// D-28.17 T4 with D-28.21: the latch never opens; a restarted host reconciles.
test('T4 a seal left waiting by a host that exited is completed by the next owner and deletion continues', async (t) => {
  const { wait, elapse, waiting } = fakeWait();
  const { registry, host, appId, token } = await running(t, { wait, write: writeTool(() => new Promise(() => {})) });
  void call(host, token);
  await settle();
  const stopping = host.service.stop({ appId });
  await until(() => waiting() > 0, 'seal wait');
  elapse();
  await assert.rejects(stopping, { code: 'instance_sealing' });

  registry.world.verdicts.set(101, 'exited');
  const restarted = registry.host({ pid: 202, ownerKind: 'cli' });
  await restarted.service.deleteCode({ appId, actor: CLI_USER });
  const ended = instance(restarted, appId);
  assert.deepEqual([ended.state, ended.stopReason], ['sealed', 'host_gone']);
  assert.ok(events(restarted, appId).includes('owner_recovered'));
  assert.ok(host.runner.calls.length > 0 && restarted.runner.calls.some(([kind]) => kind === 'stopOrphan'));
  const offer = await restarted.service.prepareDataDeletion({ appId });
  assert.equal((await restarted.service.deleteData({ appId, ticket: offer.ticket, confirm: appId, actor: CLI_USER })).status,
    'deleted');
});

// D-28.17 T5.
test('T5 a write after the data root was moved away is refused and never creates it', async (t) => {
  const { host, appId, token } = await running(t, { write: writeTool(async (_input, { dataFs }) => {
    await dataFs.mkdir('logs');
  }) });
  rmSync(host.context.dataOf(appId), { recursive: true, force: true });
  await assert.rejects(call(host, token), { code: 'data_root_missing' });
  assert.equal(existsSync(host.context.dataOf(appId)), false);
});

test('a read tool runs outside the gate and its result is discarded when the instance ends meanwhile', async (t) => {
  const reading = latch();
  const { host, appId, token } = await running(t, { read: readTool(async () => { await reading.promise; return 'stale'; }) });
  const pending = call(host, token, {}, 'resolve_knowledge_tags');
  await settle();
  assert.equal((await host.service.stop({ appId })).status, 'sealed', 'a read does not hold the gate');
  reading.open();
  await assert.rejects(pending, { code: 'result_discarded' });
});

// D-28.26 / D-28.31: two hosts, pause points L1 (checks passed, no file
// operation yet) and L2 (a file operation issued, not complete).
async function twoHosts(t, tool) {
  const counting = countingFs();
  const context = await running(t, { fs: counting.fs, write: writeTool(tool) });
  const other = context.registry.host({ pid: 202, ownerKind: 'standalone' });
  return { ...context, counting, other };
}

test('T4c-1 a live owner paused at L1 or L2 keeps its lease; the other host changes nothing', async (t) => {
  const l1 = latch();
  const atL1 = latch();
  const { host, other, appId, token, counting } = await twoHosts(t, async (_input, { dataFs }) => {
    atL1.open();
    await l1.promise;
    await dataFs.writeFile('notes.json', 'synthetic');
  });
  const l2 = latch();
  counting.holds.push(l2);
  const owner = host.context.store.owner(appId);
  const pending = call(host, token);
  await atL1.promise;
  for (const point of ['L1', 'L2']) {
    if (point === 'L2') {
      l1.open();
      await until(() => counting.calls.some(([name]) => name === 'writeFile'), 'L2');
    }
    await assert.rejects(other.service.start({ appId }), { code: 'app_owned_elsewhere' }, point);
    await assert.rejects(other.service.disable({ appId, actor: CLI_USER }), { code: 'app_owned_elsewhere' }, point);
    assert.deepEqual(other.context.store.owner(appId), owner, point);
  }
  l2.open();
  await pending;
});

test('T4c-2 stopping at L2 keeps the lease until the I/O completes, commits and releases it', async (t) => {
  const { wait, elapse, waiting } = fakeWait();
  const counting = countingFs();
  const context = await running(t, { fs: counting.fs, wait, write: writeTool(async (_input, { dataFs }) => {
    await dataFs.writeFile('notes.json', 'synthetic');
    return 'done';
  }) });
  const { host, appId, token, registry } = context;
  const other = registry.host({ pid: 202, ownerKind: 'standalone' });
  const l2 = latch();
  counting.holds.push(l2);
  const pending = call(host, token);
  await until(() => counting.calls.some(([name]) => name === 'writeFile'), 'L2');

  const stopping = host.service.stop({ appId });
  await until(() => waiting() > 0, 'seal wait');
  elapse();
  await assert.rejects(stopping, { code: 'instance_sealing' });
  assert.equal(host.context.store.owner(appId).pid, 101);
  assert.ok(events(host, appId).includes('seal_waiting_for_writes'));
  await assert.rejects(other.service.start({ appId }), { code: 'app_owned_elsewhere' });

  l2.open();
  assert.equal(await pending, 'done');
  await until(() => host.context.store.owner(appId).ownerId === null, 'released');
  assert.equal((await other.service.start({ appId })).status, 'running');
});

test('T4c-3 after a takeover on exit evidence, the old host\'s next port operation is fenced and records nothing', async (t) => {
  const { host, other, appId, token, counting, registry } = await twoHosts(t, async (_input, { dataFs }) => {
    await dataFs.writeFile('first.json', 'synthetic');
    await dataFs.writeFile('second.json', 'synthetic');
  });
  const l2 = latch();
  counting.holds.push(l2);
  const pending = call(host, token);
  await until(() => counting.calls.some(([name]) => name === 'writeFile'), 'L2');

  registry.world.verdicts.set(101, 'exited');
  const before = host.context.store.owner(appId).fence;
  await other.service.stop({ appId });
  assert.equal(other.context.store.owner(appId).fence, before + 1);
  const calls = counting.calls.length;
  const recorded = events(other, appId).length;

  l2.open();
  await assert.rejects(pending, { code: 'write_fenced_after_fs' });
  assert.equal(counting.calls.length, calls, 'no file operation after the takeover');
  assert.equal(events(other, appId).length, recorded, 'the fenced host writes no row');
});

test('T4c-4 a tool that returns while its I/O is still running is not delivered until the I/O drains', async (t) => {
  const { host, appId, token, counting } = await twoHosts(t, async (_input, { dataFs }) => {
    dataFs.writeFile('notes.json', 'synthetic');
    return 'early';
  });
  const l2 = latch();
  counting.holds.push(l2);
  let delivered = false;
  const pending = call(host, token).then((value) => { delivered = true; return value; });
  await until(() => events(host, appId).includes('write_tool_detached_io'), 'detached io');
  await settle();
  assert.equal(delivered, false);
  assert.equal(host.context.gates.holder(appId)?.toolName, 'record_decision_trace');
  assert.equal(host.context.store.lastEvent(appId, 'write_tool_detached_io').detail.pending, 1);

  l2.open();
  assert.equal(await pending, 'early');
  assert.equal(host.context.gates.holder(appId), null);
});

test('T4c-5 a port used for the first time after its call settled is closed and touches nothing', async (t) => {
  let kept;
  const { host, appId, token, counting } = await twoHosts(t, async (_input, { dataFs }) => { kept = dataFs; return 'ok'; });
  const owner = host.context.store.owner(appId);
  assert.equal(await call(host, token), 'ok');

  await assert.rejects(kept.writeFile('late.json', 'synthetic'), (error) => error.code === 'write_port_closed'
    && error.detail.op === 'writeFile' && error.detail.toolName === 'record_decision_trace');
  assert.deepEqual(counting.calls, []);
  assert.deepEqual(host.context.store.owner(appId), owner);
  assert.equal(host.context.gates.holder(appId), null);
  assert.equal(existsSync(join(host.context.dataOf(appId), 'late.json')), false);
});

test('T4c-6 the continuation of an operation registered before settlement is refused', async (t) => {
  let late;
  const { host, appId, token, counting } = await twoHosts(t, async (_input, { dataFs }) => {
    dataFs.writeFile('first.json', 'synthetic').then(() => dataFs.writeFile('second.json', 'synthetic'))
      .catch((error) => { late = error; });
    return 'ok';
  });
  const l2 = latch();
  counting.holds.push(l2);
  const pending = call(host, token);
  await until(() => events(host, appId).includes('write_tool_detached_io'), 'detached io');
  l2.open();
  assert.equal(await pending, 'ok');
  await until(() => late, 'continuation refused');
  assert.equal(late.code, 'write_port_closed');
  assert.deepEqual(counting.calls.filter(([name]) => name === 'writeFile').length, 1);
});

test('T4c-7 a port kept for a later call is refused; the new call gets its own port', async (t) => {
  let kept = null;
  const { host, appId, token } = await twoHosts(t, async (_input, { dataFs }) => {
    if (kept) {
      await assert.rejects(kept.writeFile('old.json', 'synthetic'), { code: 'write_port_closed' });
      await dataFs.writeFile('new.json', 'synthetic');
      return 'second';
    }
    kept = dataFs;
    return 'first';
  });
  assert.equal(await call(host, token), 'first');
  assert.equal(await call(host, token), 'second');
  const data = host.context.dataOf(appId);
  assert.deepEqual([existsSync(join(data, 'old.json')), existsSync(join(data, 'new.json'))], [false, true]);
});
