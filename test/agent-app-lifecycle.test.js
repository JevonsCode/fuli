import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appRegistry, CLI_USER, CONSOLE_USER, events, FILES, latch, MANIFEST, settle, verifiedApp
} from '../test-support/agent-app-hosts.js';

// rec#10 review 6373287904 (fuli#308 round 2): lifecycle races, the lease of
// concurrent acquires, detached file failures and read-only reads. Synthetic
// hosts and a fake isolation backend that starts nothing.

const TOOLS = ['record_decision_trace', 'resolve_knowledge_tags'];
const PERMISSIONS = TOOLS.map((name) => `fuli.${name}`);
const writeTool = (run) => ({ grantable: true, effect: 'write', scopeFields: ['personalSpaceId'], dataPathFields: [],
  marks: [], run });
const readTool = (run) => ({ grantable: true, effect: 'read', scopeFields: ['personalSpaceId'], dataPathFields: [],
  marks: [], run });

async function running(t, { write = writeTool(async () => 'ok'), read = readTool(async () => 'read') } = {}) {
  const registry = appRegistry(t, { tools: TOOLS });
  const host = registry.host({ pid: 101, hostTools: new Map([['record_decision_trace', write], ['resolve_knowledge_tags', read]]) });
  const app = await verifiedApp(host, { permissions: PERMISSIONS });
  await host.service.start({ appId: app.appId });
  return { registry, host, appId: app.appId, token: lastToken(host) };
}

const lastToken = (host) => host.isolation.started.at(-1).environment.FULI_APP_TOKEN;
const call = (host, token, input = {}, toolName = 'record_decision_trace') => host.service.callTool({ token, toolName, input });
const instance = (host, appId) => host.context.store.instance(appId);

test('P1-1 a start re-checks the run gate where it mints: an approval swapped during the self-check never runs', async (t) => {
  const registry = appRegistry(t, { tools: TOOLS });
  const host = registry.host({ pid: 101 });
  const app = await verifiedApp(host, { permissions: PERMISSIONS });
  const v2 = await host.service.submit({ personalSpaceId: 'space-a', agentId: 'agent-jvs',
    manifest: { ...MANIFEST, version: '1.1.0', permissions: PERMISSIONS }, files: FILES });
  const checking = latch();
  const resume = latch();
  host.isolation.hooks.selfCheck = async () => { checking.open(); await resume.promise; };
  const starting = host.service.start({ appId: app.appId });
  await checking.promise;

  // Another FULI process approves 1.1.0 from the console: unverified.
  const other = registry.host({ pid: 202, ownerKind: 'cli' });
  await other.service.approve({ appId: app.appId, version: '1.1.0', digest: v2.digest, approver: CONSOLE_USER });
  resume.open();

  const refused = await starting;
  assert.deepEqual([refused.status, refused.reason], ['run_refused', 'presence_unverified']);
  assert.equal(instance(host, app.appId), null);
  assert.equal(host.isolation.started.length, 0);
  assert.equal(host.context.store.owner(app.appId).ownerId, null);
});

test('P1-2 a start waits for a stop in flight, and the old cleanup never touches the new instance', async (t) => {
  const { host, appId } = await running(t);
  const stopping = latch();
  const resume = latch();
  host.isolation.hooks.stop = async () => { stopping.open(); await resume.promise; };
  const stopped = host.service.stop({ appId });
  await stopping.promise;
  const restarted = host.service.start({ appId });
  await settle();
  assert.equal(host.isolation.started.length, 1, 'no start while the stop is in flight');

  host.isolation.hooks.stop = null;
  resume.open();
  assert.equal((await stopped).status, 'sealed');
  const second = await restarted;
  assert.equal(second.generation, 2);
  assert.equal(host.context.instances.hosted(appId).instanceId, second.instanceId);
  assert.equal(await call(host, lastToken(host)), 'ok');
  assert.equal(host.context.store.owner(appId).pid, 101);
});

test('P1-2 a failed backend stop keeps the instance sealed, hosted and owned; the next stop finishes it', async (t) => {
  const { host, appId, token } = await running(t);
  host.isolation.hooks.stop = async () => { throw Object.assign(new Error('synthetic stop failure'), { code: 'ESYNTH' }); };
  await assert.rejects(host.service.stop({ appId }), { code: 'ESYNTH' });
  assert.deepEqual([instance(host, appId).state, instance(host, appId).stoppedAt], ['sealed', null]);
  assert.ok(host.context.instances.hosted(appId));
  assert.equal(host.context.store.owner(appId).pid, 101);
  assert.ok(events(host, appId).includes('stop_failed'));
  await assert.rejects(call(host, token), { code: 'app_sealed' });
  await assert.rejects(host.service.start({ appId }), { code: 'instance_running' });

  host.isolation.hooks.stop = null;
  assert.equal((await host.service.stop({ appId })).status, 'sealed');
  assert.equal(instance(host, appId).stopReason, 'stopped');
  assert.equal(host.context.store.owner(appId).ownerId, null);
});

test('P1-3 a decision during a start in flight waits for it, then ends the instance before changing the app', async (t) => {
  const registry = appRegistry(t, { tools: TOOLS });
  const host = registry.host({ pid: 101 });
  const app = await verifiedApp(host, { permissions: PERMISSIONS });
  const starting = latch();
  const resume = latch();
  host.isolation.hooks.start = async () => { starting.open(); await resume.promise; };
  const started = host.service.start({ appId: app.appId });
  await starting.promise;
  const disabled = host.service.disable({ appId: app.appId, actor: CLI_USER });
  await settle();
  resume.open();

  assert.equal((await started).status, 'running');
  assert.equal((await disabled).status, 'disabled');
  assert.deepEqual([instance(host, app.appId).state, instance(host, app.appId).stopReason], ['sealed', 'disable']);
  assert.equal(host.context.instances.hosted(app.appId), null);
  assert.equal(host.isolation.calls.filter(([kind]) => kind === 'stop').length, 1);
});

test('P1-3 a decision during a stop in flight waits for the stop to finish', async (t) => {
  const { host, appId } = await running(t);
  const stopping = latch();
  const resume = latch();
  host.isolation.hooks.stop = async () => { stopping.open(); await resume.promise; };
  const stopped = host.service.stop({ appId });
  await stopping.promise;
  const deleted = host.service.deleteCode({ appId, actor: CLI_USER });
  await settle();
  assert.equal(host.service.read({ appId }).status, 'active', 'nothing changes while the stop is in flight');

  resume.open();
  assert.equal((await stopped).status, 'sealed');
  assert.equal((await deleted).status, 'code_deleted');
  assert.equal(instance(host, appId).stopReason, 'stopped');
});

test('P2-4 concurrent acquires in one process share one lease, one fence and one heartbeat', async (t) => {
  const registry = appRegistry(t, { tools: TOOLS });
  const heartbeats = [];
  const timers = {
    setInterval: () => { const timer = { unref() {} }; heartbeats.push(timer); return timer; },
    clearInterval: (timer) => { heartbeats.splice(heartbeats.indexOf(timer), 1); }
  };
  const host = registry.host({ pid: 101, timers });
  const app = await verifiedApp(host);
  const before = host.context.store.owner(app.appId).fence;
  const { leases } = host.context;
  const [first, second] = await Promise.all([leases.acquire(app.appId), leases.acquire(app.appId)]);
  assert.equal(first, second);
  assert.equal(first.fence, before + 1);
  assert.deepEqual([leases.owns(first), leases.owns(second)], [true, true]);
  assert.equal(heartbeats.length, 1);
  leases.release(first);
  assert.equal(host.context.store.owner(app.appId).pid, 101);
  leases.release(second);
  assert.equal(host.context.store.owner(app.appId).ownerId, null);
  assert.equal(heartbeats.length, 0);
});

test('P1-6 a detached file operation that fails fails the call and is never committed', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  let handled = null;
  const { host, appId, token } = await running(t, { write: writeTool(async (input, { dataFs }) => {
    if (input.mode === 'detached') {
      dataFs.writeFile('missing/notes.json', 'synthetic');
      return 'claimed success';
    }
    try {
      await dataFs.writeFile('missing/notes.json', 'synthetic');
    } catch (error) {
      handled = error.code;
    }
    return 'handled';
  }) });

  await assert.rejects(call(host, token, { mode: 'detached' }), { code: 'ENOENT' });
  assert.equal(events(host, appId).includes('write_committed'), false);
  // A failure the tool awaited and handled stays the tool's own.
  assert.equal(await call(host, token, { mode: 'awaited' }), 'handled');
  assert.equal(handled, 'ENOENT');
  await settle();
  assert.deepEqual(unhandled, []);
});

test('a read tool gets a read-only data port', async (t) => {
  const { host, token } = await running(t, { read: readTool(async (_input, { dataFs }) => {
    await dataFs.writeFile('notes.json', 'synthetic');
  }) });
  await assert.rejects(call(host, token, {}, 'resolve_knowledge_tags'), { code: 'read_only_port' });
});

test('scope violations are counted per instance: a new instance starts at zero', async (t) => {
  const { host, appId, token } = await running(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(call(host, token, { personalSpaceId: 'space-b' }), { code: 'scope_violation' });
  }
  await host.service.stop({ appId });
  await host.service.start({ appId });
  await assert.rejects(call(host, lastToken(host), { personalSpaceId: 'space-b' }), { code: 'scope_violation' });
  await settle();
  assert.equal(instance(host, appId).state, 'running');
});
