import assert from 'node:assert/strict';
import test from 'node:test';
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
async function paired(t, personal) {
  const identity = async () => deviceIdentity(await createDeviceCertificate());
  const [host, runner] = await Promise.all([identity(), identity()]);
  const store = new RunnerHostStore(':memory:', { spaceId: () => spaceId });
  const code = 'synthetic-scoped-invitation';
  store.invite({ code, name: 'B', scopes: ['global'] });
  store.pair({ code, fingerprint: runner.fingerprint });
  const app = { config: { personal: { spaceId } }, personal };
  const routes = createRunnerRoutes({ app, store, hostName: 'A', hostFingerprint: host.fingerprint, reservationsEnabled: () => true,
    withLease: (_owner, work) => work() });
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
  return { connection, store, host, runner, routes };
}

test('limited pairing exposes its approved export and drops it when permission changes during the read', async t => {
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const { connection, store, runner } = await paired(t, { async exportScope() {
    started.resolve();
    await finish.promise;
    return { scope: 'global', spaceId, complete: true, digest: 'a'.repeat(64), bytes: 9, text: 'synthetic' };
  } });
  const hello = await connection.hello();
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
  const worker = startOwnerWorker({ connection, identity: runner.fingerprint, projects: () => ['sample'],
    descriptor: () => ({ device: runner.fingerprint, authority: host.fingerprint, spaceId }), retryMs: 20,
    catalog: async () => ({ count: 1, digest: inventoryDigest(['sample']) }),
    exportScope: async () => ({ scope, complete: true, spaceId, text, digest }) });
  try {
    const registry = store.ownership();
    for (let i = 0; i < 200 && registry.owner('sample')?.state !== 'owned'; i++) await delay(25);
    assert.equal(registry.owner('sample')?.state, 'owned');
    assert.equal(registry.owner('sample').owner, runner.fingerprint);
    assert.deepEqual(seen, [{ projectId: 'sample', personalSpaceId: spaceId, envelope: text }]);
    const call = { requestId: 'one', scope, spaceId, generation: 2, action: 'project_read', owner: runner.fingerprint };
    assert.equal((await routes.ownerRequest(call)).dispatched, false);
  } finally { await worker.close(); }
});
