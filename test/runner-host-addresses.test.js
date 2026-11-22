import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { runRunnerCommand } from '../src/cli/runner-command.js';
import { createHostConnection } from '../src/runner/host-connection.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';

// A host listening on loopback that names two LAN addresses of its own, and a runner store paired with it.
async function pairedHost(t, { knownAddresses, announces = ['10.20.2.17', '192.168.1.187'] }) {
  const [host, runner] = await Promise.all([createDeviceCertificate(), createDeviceCertificate()].map(async (made) => deviceIdentity(await made)));
  const hostStore = new RunnerHostStore(':memory:');
  hostStore.invite({ code: 'synthetic-invitation-code-0003', name: 'Runner B' });
  hostStore.pair({ code: 'synthetic-invitation-code-0003', fingerprint: runner.fingerprint, name: 'Runner B' });
  const routes = createRunnerRoutes({ app: {}, store: hostStore, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation(), hostAddresses: () => announces });
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, route: routes.handle,
    sourceAllowed: () => true });
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-addresses-')));
  const store = new RunnerStore(path.join(dir, RUNNER_FILE));
  store.saveHost({ name: 'Host A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port, addresses: knownAddresses });
  t.after(async () => {
    store.close();
    await listener.close();
    await routes.close();
    hostStore.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, runner, port: listener.port, dir };
}

test('a runner keeps the addresses the host names, so it looks there after the next network change', async (t) => {
  const { store, runner } = await pairedHost(t, { knownAddresses: ['127.0.0.1'] });
  const connection = createHostConnection({ store, identity: runner, lookUp: async () => [], bindAddresses: () => [] });
  t.after(() => connection.close());
  assert.equal((await connection.connect()).address, '127.0.0.1');
  // Newest first; the one that answered is kept apart and tried whatever this list holds.
  assert.deepEqual(store.host().addresses, ['10.20.2.17', '192.168.1.187', '127.0.0.1']);
  assert.equal(store.host().lastAddress, '127.0.0.1');
});

test('each address is also tried from each adapter\'s own address, and a route that cannot be used does not stop the others', async (t) => {
  const { store, runner } = await pairedHost(t, { knownAddresses: ['127.0.0.1'] });
  // 192.0.2.1 is no address of this computer (TEST-NET-1): connecting from it fails at once; loopback answers.
  const connection = createHostConnection({ store, identity: runner, lookUp: async () => [], bindAddresses: () => ['192.0.2.1', '127.0.0.1'] });
  t.after(() => connection.close());
  const reached = await connection.connect();
  assert.equal(reached.address, '127.0.0.1');
  assert.ok([null, '127.0.0.1'].includes(reached.via));
  // What it reached by is what later requests take.
  assert.equal((await reached.fetch(`${reached.origin}/runner/1/hello`)).status, 200);
});

test('the person names where the host is now; it is tried first and kept, and only an address the host can serve is taken', async (t) => {
  const { store } = await pairedHost(t, { knownAddresses: ['192.168.1.187'] });
  store.learnHostAddresses(['10.20.2.17'], { first: true });
  assert.deepEqual(store.host().addresses, ['10.20.2.17', '192.168.1.187']);
  // Again: no duplicate, still first.
  store.learnHostAddresses(['10.20.2.17'], { first: true });
  assert.deepEqual(store.host().addresses, ['10.20.2.17', '192.168.1.187']);
  for (const bad of ['8.8.8.8', 'example.com', '']) {
    await assert.rejects(() => runRunnerCommand(['add-address', bad], { env: {}, write: () => {} }), /private or VPN IPv4/);
  }
});

test('a host reached over a VPN is learned from its hello and can be named by hand', async (t) => {
  // The range Tailscale and many company VPNs hand out, which the host serves on its VPN adapters.
  const { store, runner, dir } = await pairedHost(t, { knownAddresses: ['127.0.0.1'], announces: ['100.84.12.9'] });
  const connection = createHostConnection({ store, identity: runner, lookUp: async () => [], bindAddresses: () => [] });
  t.after(() => connection.close());
  await connection.connect();
  assert.ok(store.host().addresses.includes('100.84.12.9'), 'the address the host says it serves over the VPN is kept');

  store.close();
  const lines = [];
  await runRunnerCommand(['add-address', '100.84.12.10', '--data-dir', dir], { env: {}, write: (line) => lines.push(line) });
  const reopened = new RunnerStore(path.join(dir, RUNNER_FILE));
  t.after(() => reopened.close());
  assert.equal(reopened.host().addresses[0], '100.84.12.10');
});

test('the address list makes room for a new one instead of staying full for ever', async (t) => {
  const sixteen = Array.from({ length: 16 }, (_, index) => `10.20.2.${index + 1}`);
  const { store } = await pairedHost(t, { knownAddresses: sixteen });
  store.learnHostAddresses(['192.168.1.187']);
  const kept = store.host().addresses;
  assert.equal(kept.length, 16);
  assert.ok(kept.includes('192.168.1.187'), 'the host moved networks: the newest address is learned');
  assert.equal(kept.includes('10.20.2.16'), false, 'the one that answered longest ago makes room');
});

test('an address is read by its own position, not by the first place that value appears', async (t) => {
  const { store, dir } = await pairedHost(t, { knownAddresses: ['192.168.1.187'] });
  store.close();
  // --data-dir happens to be given the same text: reading by indexOf took the address for its value.
  await runRunnerCommand(['add-address', '--data-dir', dir, '10.20.2.17', '--data-dir', dir],
    { env: {}, write: () => {} });
  const reopened = new RunnerStore(path.join(dir, RUNNER_FILE));
  t.after(() => reopened.close());
  assert.equal(reopened.host().addresses[0], '10.20.2.17');
});

test('only checked addresses are written, whichever way they are learned', async (t) => {
  const { store } = await pairedHost(t, { knownAddresses: ['192.168.1.187'] });
  store.learnHostAddresses([null, 42, { address: '10.0.0.1' }, '8.8.8.8'], { first: true });
  assert.deepEqual(store.host().addresses, ['192.168.1.187']);
});
