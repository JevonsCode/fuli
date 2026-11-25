import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostMoveService } from '../src/runner/move-service.js';
import { followerTransfer } from '../src/runner/follower-transfer.js';
import { MoveStore } from '../src/runner/move-store.js';
import { projectMoveCoordinator } from '../src/runner/project-move.js';
import { MOVE_ACTION, wireMove } from '../src/runner/move-wire.js';
import { ownerPermitStore } from '../src/runner/owner-permit.js';
import { setTimeout as delay } from 'node:timers/promises';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { createHostConnection } from '../src/runner/host-connection.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { inventoryDigest } from '../src/runner/owner-inventory.js';
import { startOwnerWorker } from '../src/runner/owner-worker.js';
import { RUNNER_PATHS as paths } from '../src/runner/protocol.js';
import { RunnerStore } from '../src/runner/runner-store.js';

const spaceId = 'synthetic-space';
async function paired(t, personal, now = Date.now, { moveTicket, moveControl, projectGeneration, scopes = ['global'] } = {}) {
  const identity = async () => deviceIdentity(await createDeviceCertificate());
  const [host, runner] = await Promise.all([identity(), identity()]);
  const store = new RunnerHostStore(':memory:', { spaceId: () => spaceId });
  const code = 'synthetic-scoped-invitation';
  store.invite({ code, name: 'B', scopes });
  store.pair({ code, fingerprint: runner.fingerprint });
  const app = { config: { personal: { spaceId } }, personal };
  const routes = createRunnerRoutes({ app, store, hostName: 'A', hostFingerprint: host.fingerprint, reservationsEnabled: () => true,
    now, moveTicket, moveControl, projectGeneration, withLease: (_owner, work) => work() });
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: routes.handle });
  const follower = new RunnerStore(':memory:');
  follower.saveHost({ name: 'A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port, addresses: ['127.0.0.1'] });
  const connection = createHostConnection({ store: follower, identity: runner, lookUp: async () => [], bindAddresses: () => [] });
  t.after(async () => {
    connection.close();
    await routes.close();
    await listener.close();
    follower.close();
    store.close();
  });
  return { connection, store, host, runner, routes, follower };
}

test('limited pairing exposes its approved export and drops it when permission changes during the read', async t => {
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const { connection, store, runner, follower } = await paired(t, { async exportScope() {
    started.resolve();
    await finish.promise;
    return { scope: 'global', spaceId, complete: true, digest: 'a'.repeat(64), bytes: 9, text: 'synthetic' };
  } });
  follower.rememberAnswer('before', 'read', { synthetic: true });
  const hello = await connection.hello();
  assert.equal(follower.answer('before'), null);
  assert.ok(follower.host().limitedAt);
  follower.rememberAnswer('late', 'read', { synthetic: true });
  assert.equal(follower.answer('late'), null);
  assert.equal(hello.ownerProtocol, 1);
  assert.equal(hello.limited, true);
  assert.equal(hello.mcpSessions, undefined);
  for (const route of [paths.mcp, paths.hook, paths.replay, paths.workspace, paths.console + '/api/search', paths.console + '/api/events']) {
    assert.deepEqual((await connection.postJson(route, {})).body, { error: 'scope_grant_required' });
  }
  const request = await connection.postJson(paths.scopeRequest, { spaceId, scope: 'project:sample' });
  assert.equal(request.body.state, 'pending');
  assert.equal((await connection.getText(paths.scope + '?scope=project:sample', { maxBytes: 1024 })).status, 403);
  const grants = store.grants(runner.fingerprint);
  const reading = connection.getText(paths.scope + '?scope=global&part=envelope', { maxBytes: 1024 });
  await started.promise;
  const row = grants.list();
  assert.equal(grants.decide({ pairing: row.pairing, scope: 'global', state: 'revoked', version: 1 }).ok, true);
  finish.resolve();
  const refused = await reading;
  assert.equal(refused.status, 403);
  assert.deepEqual(JSON.parse(refused.text), { error: 'scope_grant_required' });
});

test('a paired owner proves its report with a live catalog and its exact export over TLS', async t => {
  const digest = 'd'.repeat(64), scope = 'project:sample';
  const text = '{"value":12345678901234567890,"name":"样本"}';
  const seen = [];
  const { connection, store, host, runner, routes } = await paired(t, { async verifyProjectExport(input) {
    seen.push(input);
    return { digest, project: 'sample', spaceId };
  } });
  const dir = mkdtempSync(join(tmpdir(), 'fuli-existing-owner-'));
  const permits = new RunnerHostStore(join(dir, 'runner', 'host.sqlite'), { spaceId: () => spaceId });
  t.after(() => { permits.close(); rmSync(dir, { recursive: true, force: true }); });
  const record = { device: runner.fingerprint, authority: host.fingerprint, spaceId };
  const installed = ownerPermitStore(dir, permits);
  const worker = startOwnerWorker({ connection, identity: runner.fingerprint, projects: () => ['sample'],
    descriptor: () => record, retryMs: 20, ...installed,
    dispatch: async job => ({ ok: ['history_read','project_update'].includes(job.action), generation: installed.generation(record, scope) }),
    catalog: async () => ({ count: 1, digest: inventoryDigest(['sample']) }),
    exportScope: async () => ({ scope, complete: true, spaceId, text, digest }) });
  try {
    const registry = store.ownership();
    for (let i = 0; i < 200 && registry.owner('sample')?.state !== 'owned'; i++) await delay(25);
    assert.equal(registry.owner('sample')?.state, 'owned');
    assert.equal(registry.owner('sample').owner, runner.fingerprint);
    let reply;
    for (let i = 0; i < 100; i++) {
      reply = await routes.ownerRequest({ scope, spaceId, action: 'history_read', owner: runner.fingerprint,
        requestId: 'sample-history', generation: 1 });
      if (reply.ok) break;
      await delay(20);
    }
    assert.deepEqual(reply.result, { ok: true, generation: 1 });
    const update = await routes.ownerRequest({ scope, spaceId, action: 'project_update', owner: runner.fingerprint,
      requestId: 'sample-update', generation: 1, input: { profile: { name: 'Updated' }, expectedUpdatedAt: new Date(0).toISOString() } });
    assert.deepEqual(update.result, { ok: true, generation: 1 });
    assert.deepEqual(seen, [{ projectId: 'sample', personalSpaceId: spaceId, envelope: text }]);
    const call = { requestId: 'one', scope, spaceId, generation: 2, action: 'project_read', owner: runner.fingerprint };
    assert.equal((await routes.ownerRequest(call)).dispatched, false);
  } finally { await worker.close(); }
});

test('a conflicting ID stays occupied while the next project on that device is independently verified', async t => {
  const ids = ['conflict', 'bad', 'healthy'];
  let clock = Date.now();
  const digest = 'f'.repeat(64);
  let catalogs = 0, repaired = false;
  const exports = [];
  const { connection, store, host, runner, routes } = await paired(t, {
    verifyProjectExport: async ({ projectId }) => ({ project: projectId, digest, spaceId })
  }, () => clock);
  const registry = store.ownership();
  registry.verified(host.fingerprint, ['conflict']);
  const inventoryRequests = [];
  const monitored = {
    hello: () => connection.hello(),
    async postJson(path, ...args) {
      const reply = await connection.postJson(path, ...args);
      if (path === paths.ownerPoll && clock > start + 60_000) inventoryRequests.push(reply.body?.needInventory);
      return reply;
    }
  };
  const start = clock;
  const worker = startOwnerWorker({ connection: monitored, identity: runner.fingerprint, projects: () => [...ids],
    descriptor: () => ({ device: runner.fingerprint, authority: host.fingerprint, spaceId }),
    catalog: async () => { catalogs++; return { count: ids.length, digest: inventoryDigest(ids) }; },
    exportScope: async job => {
      exports.push(job.scope);
      if (job.scope === 'project:bad' && !repaired) return { complete: false };
      return { scope: job.scope, complete: true, spaceId, digest, text: '{"sample":true}' };
    }
  });
  try {
    for (let i = 0; i < 200 && registry.owner('healthy')?.state !== 'owned'; i++) await delay(25);
    assert.equal(registry.owner('conflict')?.state, 'conflict');
    assert.equal(registry.owner('conflict').owner, host.fingerprint);
    assert.equal(registry.owner('healthy')?.owner, runner.fingerprint);
    assert.equal(registry.owner('healthy')?.state, 'owned');
    assert.equal(registry.reserve(host.fingerprint, 'unrelated', 'create').ok, true);
    clock += 120_000;
    // Complete additional live polls without waiting for real-time poll expiry.
    for (let i = 0; i < 4; i++) {
      const call = await routes.ownerRequest({ requestId: 'live-' + i, owner: runner.fingerprint,
        scope: 'project:healthy', spaceId, generation: 1, action: 'project_read' });
      assert.equal(call.dispatched, true);
    }
    assert.ok(inventoryRequests.length >= 3);
    assert.ok(inventoryRequests.every(value => value === false));
    assert.equal(catalogs, 1);
    assert.deepEqual(exports, ['project:bad', 'project:healthy']);
    repaired = true;
    clock += 300_000;
    for (let i = 0; i < 30 && registry.owner('bad')?.state !== 'owned'; i++) {
      await routes.ownerRequest({ requestId: 'repair-' + i, owner: runner.fingerprint,
        scope: 'project:healthy', spaceId, generation: 1, action: 'project_read' });
      await delay(25);
    }
    assert.equal(registry.owner('bad')?.state, 'owned', JSON.stringify({ exports, catalogs, inventoryRequests }));
    assert.equal(exports.filter(scope => scope === 'project:healthy').length, 1);
  } finally { await worker.close(); }
});


test('mutual TLS carries each participant phase and its matching authority decision in either direction', async t => {
  let coordinator;
  const { connection, store, host, runner, routes } = await paired(t, {}, Date.now, {
    scopes: ['global','project:incoming','project:outgoing'],
    moveTicket: (peer, move) => {
      if (peer !== runner.fingerprint) return null;
      try { return coordinator.ticket(move); } catch { return null; }
    }
  });
  const db = new MoveStore(':memory:');
  t.after(() => db.close());
  const registry = store.ownership();
  const authority = host.fingerprint, device = runner.fingerprint;
  for (const [owner, ids] of [[authority,['outgoing']], [device,['incoming']]]) {
    assert.equal(registry.verified(owner, ids).ok, true);
  }
  coordinator = projectMoveCoordinator({ store: db, registry, space: spaceId, authority,
    pairing: (peer, project) => store.grants(peer).allowed('project:' + project) && store.grants(peer).pairing() });
  const worker = startOwnerWorker({ connection, identity: device, projects: () => [], retryMs: 10,
    descriptor: () => ({ device, authority, spaceId }), catalog: async () => ({ count: 0, digest: inventoryDigest([]) }),
    movePhase: async (phase, move) => {
      if (phase === 'inspect') throw Object.assign(new Error('local detail'), { code: move.project === 'incoming'
        ? 'project_tasks_still_active' : 'private_runtime_detail' });
      const result = await connection.postJson(paths.moveDecision, move);
      return { ok: result.status === 200, decision: result.body.decision, phase };
    } });
  try {
    for (const [project,target,phase,wrongPhase] of [['outgoing',device,'stage','seal'],['incoming',authority,'seal','stage']]) {
      const move = wireMove(coordinator.start({ project, target, reason: 'Synthetic transfer', moveId: 'request-' + project }));
      assert.equal(registry.decidePairedMove(authority, move, 'preparing').ok, true);
      const decision = await connection.postJson(paths.moveDecision, move);
      assert.equal(decision.status, 200);
      assert.equal(decision.body.decision, 'preparing');
      const unknown = await connection.postJson(paths.moveDecision, { ...move, generation: 9 });
      assert.equal(unknown.status, 403);
      const job = { owner: device, spaceId, scope: 'project:' + project, generation: 1, action: MOVE_ACTION, requestId: project };
      const ask = phase => routes.ownerRequest({ ...job, input: { phase, move } });
      assert.equal((await ask(wrongPhase)).dispatched, false);
      async function delivered(action) {
        let reply;
        for (let i = 0; i < 100; i++) {
          reply = await ask(action);
          if (reply.code !== 'owner_offline') return reply.result;
          await delay(20);
        }
        assert.fail('Owner did not receive the transfer phase');
      }
      assert.deepEqual(await delivered(phase), { ok: true, decision: 'preparing', phase });
      assert.deepEqual(await delivered('inspect'), { ok: false, code: project === 'incoming'
        ? 'project_tasks_still_active' : 'owner_action_unavailable' });
      assert.equal(registry.decidePairedMove(authority, move, 'aborted').ok, true);
      assert.equal((await ask(phase)).dispatched, false);
      if (project === 'incoming') {
        store.revoke(device);
        store.invite({ code: 'return-for-decision', name: 'Returning participant', scopes: ['global'] });
        store.pair({ code: 'return-for-decision', fingerprint: device });
        assert.equal(store.grants(device).allowed('project:incoming'), false);
        assert.notEqual(store.grants(device).pairing(), move.pairing);
        const saved = await connection.postJson(paths.moveDecision, move);
        assert.equal(saved.body.decision, 'aborted');
        assert.equal(saved.body.seal, null);
        let restored;
        for (let i = 0; i < 100; i++) {
          restored = await ask('abort');
          if (restored.code !== 'owner_offline') break;
          await delay(20);
        }
        assert.deepEqual(restored.result, { ok: true, decision: 'aborted', phase: 'abort' });
        assert.equal((await ask('inspect')).dispatched, false);
      }
    }
  } finally { await worker.close(); }
});

test('a former owner fetches only the exact space, project generation and pairing it retained', async t => {
  const { hostCopySource } = await import('../src/runner/forwarded-project-copies.js');
  const digest = 'd'.repeat(64), text = '{"synthetic":true}';
  const { connection, runner, host, store } = await paired(t, {
    exportScope: async ({ scope }) => ({ scope, spaceId, complete: true, digest, text, bytes: Buffer.byteLength(text) })
  }, Date.now, { scopes: ['project:sample'], projectGeneration: scope => scope === 'project:sample' ? 2 : null });
  const hello = await connection.hello();
  assert.equal(hello.projectPairing, store.grants(runner.fingerprint).pairing());
  const record = { owner: host.fingerprint, generation: 2, project: 'sample', pairing: hello.projectPairing };
  const source = hostCopySource(connection, spaceId);
  const summary = await source.summary(record);
  assert.equal(summary.result.digest, digest);
  assert.deepEqual(await source.envelope(record, summary.result), { ok: true, text });
  assert.equal((await source.summary({ ...record, generation: 1 })).ok, false);
  assert.equal((await source.envelope({ ...record, pairing: 'old' }, summary.result)).ok, false);
});

test('paired transfer intent is scoped to both devices, its original words and the live pairing', async t => {
  let service;
  const { connection, store, host, runner } = await paired(t, {}, Date.now, {
    scopes: ['project:offered','project:shared'], moveControl: (peer, body) => service.control(peer, body)
  });
  const dir = mkdtempSync(join(tmpdir(), 'fuli-transfer-intent-'));
  const pair = { spaceId, authority: host.fingerprint, device: runner.fingerprint,
    pairing: store.grants(runner.fingerprint).pairing() };
  const registry = store.ownership();
  registry.verified(pair.authority, ['shared']);
  registry.verified(pair.device, ['offered']);
  service = hostMoveService({ dataDir: dir, descriptor: { ...pair, device: pair.authority }, hostStore: store,
    request: async () => ({ ok: false, code: 'owner_offline' }), withPersonal: () => { throw Error('fixture offline'); } });
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const start = { action: 'start', project: 'offered', target: 'host', reason: 'Move my sample to the host.', moveId: 'intent-example' };
  const ask = (input, relayed = true) => followerTransfer({ pair, connection, input, relayed });
  assert.equal((await ask({ ...start, target: 'c'.repeat(64) })).status, 400);
  assert.equal((await ask({ ...start, project: 'shared', target: 'here' })).status, 403);
  assert.equal((await ask({ ...start, project: 'unlisted' })).status, 403);
  const result = await ask(start);
  assert.equal(result.status, 200);
  assert.equal(result.body.moveId, start.moveId);
  assert.equal(service.status(start.project, start.moveId).intent_source, 'peer_agent');
  assert.equal(service.status(start.project, start.moveId).reason, start.reason);
  assert.equal((await ask(start)).status, 200);
  assert.equal((await ask({ ...start, reason: 'Changed words.' })).status, 409);
  assert.equal((await ask(start, false)).status, 409);
  assert.equal((await ask({ ...start, action: 'status' })).status, 200);
  assert.equal((await followerTransfer({ pair: { ...pair, pairing: 'former' }, connection, input: start })).status, 403);
  const row = store.grants(pair.device);
  row.decide({ scope: 'project:offered', state: 'revoked', pairing: pair.pairing, version: 1 });
  const denied = await ask({ ...start, action: 'status' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'move_project_grant_required');
  assert.equal(denied.body.project, undefined);
});
