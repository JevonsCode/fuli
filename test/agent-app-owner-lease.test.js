import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  appRegistry, CLI_USER, events, latch, ownerColumns, settle, until, verifiedApp
} from '../test-support/agent-app-hosts.js';

// rec#7 D-28.21, D-28.25, D-28.29: the owner lease across FULI processes.
// Each "host" is a context over the same registry; liveness is synthetic.

async function owned(t) {
  const registry = appRegistry(t);
  const first = registry.host({ pid: 101 });
  const app = await verifiedApp(first);
  await first.service.start({ appId: app.appId });
  const second = registry.host({ pid: 202, ownerKind: 'cli' });
  return { registry, first, second, appId: app.appId };
}

const tree = (directory) => readdirSync(directory, { recursive: true }).map(String).sort();

test('T4a a live owner keeps the app: the other host changes no column and no file, and only records the refusal', async (t) => {
  const { first, second, appId } = await owned(t);
  writeFileSync(join(first.context.dataOf(appId), 'notes.json'), 'synthetic');
  const columns = ownerColumns(first, appId);
  const files = tree(first.context.dataOf(appId));
  const before = events(first, appId);

  for (const attempt of [() => second.service.deleteCode({ appId, actor: CLI_USER }),
    () => second.service.exportData({ appId, destination: join(first.context.dataOf(appId), '..', 'export') }),
    () => second.service.stop({ appId })]) {
    await assert.rejects(attempt(), (error) => error.code === 'app_owned_elsewhere'
      && error.detail.reason === 'owner_alive' && error.detail.pid === 101 && error.detail.ownerKind === 'console');
  }
  assert.deepEqual(ownerColumns(first, appId), columns);
  assert.deepEqual(tree(first.context.dataOf(appId)), files);
  assert.deepEqual(events(first, appId).slice(before.length), ['takeover_refused', 'takeover_refused', 'takeover_refused']);
});

test('T4b exit evidence lets the next host take over, raise the fence, finish the seal and delete', async (t) => {
  const { registry, first, second, appId } = await owned(t);
  const { fence } = ownerColumns(first, appId);
  registry.world.verdicts.set(101, 'exited');

  await second.service.deleteCode({ appId, actor: CLI_USER });
  const recovered = second.context.store.lastEvent(appId, 'owner_recovered');
  assert.deepEqual(recovered.detail, { from: { ownerKind: 'console', pid: 101 }, reason: 'host_gone', fence: fence + 1 });
  assert.equal(second.context.store.instance(appId).stopReason, 'host_gone');
  const offer = await second.service.prepareDataDeletion({ appId });
  await second.service.deleteData({ appId, ticket: offer.ticket, confirm: appId, actor: CLI_USER });
  assert.equal(second.service.read({ appId }).status, 'deleted');
  assert.equal(ownerColumns(second, appId).ownerId, null);
});

test('T4d a live owner with a stale heartbeat is unresponsive; --force is refused and signals nothing', async (t) => {
  const { registry, first, second, appId } = await owned(t);
  registry.clock.now += 31_000;
  const columns = ownerColumns(first, appId);
  await assert.rejects(second.service.stop({ appId }), { code: 'instance_unresponsive' });
  const kill = t.mock.method(process, 'kill');
  await assert.rejects(second.service.stop({ appId, force: true }), (error) => error.code === 'stop_force_unsupported'
    && error.detail.reason === 'no_stable_process_reference' && error.detail.ownerPid === 101);
  assert.equal(kill.mock.callCount(), 0);
  assert.deepEqual(ownerColumns(first, appId), columns);
  assert.equal(first.context.store.instance(appId).state, 'running');
});

test('T6 an operation lease of a CLI blocks an activation elsewhere until it ends, and the reverse', async (t) => {
  const registry = appRegistry(t);
  const consoleHost = registry.host({ pid: 101 });
  const cli = registry.host({ pid: 202, ownerKind: 'cli' });
  const app = await verifiedApp(consoleHost);
  const exporting = latch();
  const running = cli.context.operations.run(app.appId, 'exportData', () => exporting.promise, { keepInstance: true });
  await until(() => ownerColumns(cli, app.appId).pid === 202, 'cli lease');

  await assert.rejects(consoleHost.service.start({ appId: app.appId }), { code: 'app_owned_elsewhere' });
  exporting.open();
  await running;
  assert.equal((await consoleHost.service.start({ appId: app.appId })).status, 'running');
  await assert.rejects(cli.service.exportData({ appId: app.appId, destination: join(registry.directory, 'export') }),
    { code: 'app_owned_elsewhere' });
});

test('T7 a reused PID whose identity no longer matches counts as exited', async (t) => {
  const { registry, second, appId } = await owned(t);
  // The adapter answers exited for an identity mismatch (agent-app-host-identity.test.js).
  registry.world.verdicts.set(101, 'exited');
  assert.equal((await second.service.stop({ appId })).status, 'stopped');
  assert.equal(ownerColumns(second, appId).ownerId, null);
});

for (const [label, verdict] of [['T8 a foreign platform prefix', 'unknown'], ['T9 an unreadable process table', 'unknown']]) {
  test(`${label} is unknown: the takeover and --force are refused without any signal`, async (t) => {
    const { registry, first, second, appId } = await owned(t);
    registry.world.verdicts.set(101, verdict);
    const columns = ownerColumns(first, appId);
    const kill = t.mock.method(process, 'kill');
    for (const force of [false, true]) {
      await assert.rejects(second.service.stop({ appId, force }), (error) => error.code === 'app_owned_elsewhere'
        && error.detail.reason === 'owner_unverifiable');
    }
    assert.equal(kill.mock.callCount(), 0);
    assert.deepEqual(ownerColumns(first, appId), columns);
  });
}

test('T10 an owner row that changed during the probe is not taken over', async (t) => {
  const { registry, first, second, appId } = await owned(t);
  const third = registry.host({ pid: 303, ownerKind: 'standalone' });
  registry.world.verdicts.set(101, 'exited');
  registry.world.onProbe = async (pid) => {
    if (pid !== 101) return;
    registry.world.onProbe = null;
    // Another host takes the app over while this probe runs.
    await third.service.stop({ appId });
    await third.context.leases.acquire(appId);
  };

  await assert.rejects(second.service.stop({ appId }), { code: 'app_owned_elsewhere' });
  assert.equal(ownerColumns(first, appId).pid, 303);
  const refusals = second.context.store.events(appId, 100).filter(({ action }) => action === 'takeover_refused')
    .map(({ detail }) => detail.reason);
  assert.deepEqual(refusals, ['owner_changed', 'owner_alive']);
});

test('T12 --force against a live owner is unsupported on every platform and leaves owner and fence as they were', async (t) => {
  const { first, second, appId } = await owned(t);
  const columns = ownerColumns(first, appId);
  const kill = t.mock.method(process, 'kill');
  await assert.rejects(second.service.stop({ appId, force: true }), (error) => error.code === 'stop_force_unsupported'
    && /stop that host first/i.test(error.message) && /请先停止该宿主后重试/.test(error.message));
  assert.equal(kill.mock.calls.filter(({ arguments: [, signal] }) => signal !== 0).length, 0);
  assert.equal(kill.mock.callCount(), 0);
  assert.deepEqual(ownerColumns(first, appId), columns);
});

test('the lease is reentrant within one process and released by its last holder', async (t) => {
  const registry = appRegistry(t);
  const host = registry.host({ pid: 101 });
  const app = await verifiedApp(host);
  const outer = await host.context.leases.acquire(app.appId);
  const inner = await host.context.leases.acquire(app.appId);
  assert.equal(inner, outer);
  host.context.leases.release(inner);
  assert.equal(ownerColumns(host, app.appId).pid, 101);
  host.context.leases.release(outer);
  await settle();
  assert.equal(ownerColumns(host, app.appId).ownerId, null);
});
