import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { connect as connectTcp } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
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
  const hellos = { count: 0 };
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0,
    sourceAllowed: () => true,
    route: (request, response, context) => {
      if (context.pathname.endsWith('/hello')) hellos.count += 1;
      return routes.handle(request, response, context);
    } });
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
  return { store, runner, port: listener.port, dir, hellos };
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
  // Closed before the folder is deleted: Windows refuses to delete a SQLite file still open.
  try {
    assert.equal(reopened.host().addresses[0], '100.84.12.10');
  } finally {
    reopened.close();
  }
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
  try {
    assert.equal(reopened.host().addresses[0], '10.20.2.17');
  } finally {
    reopened.close();
  }
});

test('only checked addresses are written, whichever way they are learned', async (t) => {
  const { store } = await pairedHost(t, { knownAddresses: ['192.168.1.187'] });
  store.learnHostAddresses([null, 42, { address: '10.0.0.1' }, '8.8.8.8'], { first: true });
  assert.deepEqual(store.host().addresses, ['192.168.1.187']);
});

test('finding the host already asks it how things stand, so nothing asks a second time', async (t) => {
  const { store, runner, hellos } = await pairedHost(t, { knownAddresses: ['127.0.0.1'] });
  const connection = createHostConnection({ store, identity: runner, lookUp: async () => [], bindAddresses: () => [] });
  t.after(() => connection.close());
  await connection.connect();
  const found = hellos.count;

  assert.equal((await connection.hello())?.name, 'Host A');
  assert.equal(hellos.count, found, 'the search\'s own hello is the answer');
  // A later one asks again: the counts it carries move.
  assert.equal((await connection.hello())?.name, 'Host A');
  assert.equal(hellos.count, found + 1);
});

// The listener's connection limits (docs/runner.md, "Finding the host again"):
// the total is over every address it binds, and one address's share of the
// connections a device that is not a paired runner may hold.

// A listener on addresses that answers every request, with the limits given,
// and what each test opens: tls(identity) holds a TLS connection and tcp() a
// bare one that never starts a handshake; each resolves true while it is held.
async function limitedListener(t, { limits, addresses = ['127.0.0.1'], paired }) {
  const host = deviceIdentity(await createDeviceCertificate());
  const listener = await startRunnerListener({ identity: host, addresses, port: 0, limits,
    sourceAllowed: () => true, isPairedDevice: (fingerprint) => fingerprint === paired?.fingerprint,
    route: (_request, response) => { response.writeHead(204).end(); return true; } });
  const open = [];
  t.after(async () => {
    for (const socket of open) socket.destroy();
    await listener.close();
  });
  const settle = (socket, resolve) => {
    open.push(socket);
    socket.on('error', () => resolve(false));
    socket.on('close', () => resolve(false));
  };
  return {
    listener,
    open,
    tls: (identity, address = '127.0.0.1') => new Promise((resolve) => {
      const socket = tlsConnect({ host: address, port: listener.port, ...identity.tlsOptions, rejectUnauthorized: false },
        () => setTimeout(() => resolve(!socket.destroyed), 50));
      settle(socket, resolve);
    }),
    tcp: () => new Promise((resolve) => {
      const socket = connectTcp(listener.port, '127.0.0.1', () => setTimeout(() => resolve(!socket.destroyed), 100));
      settle(socket, resolve);
    })
  };
}

test('an unknown device holds exactly its share of one address\'s connections, handshake finished or not', async (t) => {
  const stranger = deviceIdentity(await createDeviceCertificate());
  const finished = await limitedListener(t, {});
  const held = await Promise.all(Array.from({ length: 40 }, () => finished.tls(stranger)));
  assert.equal(held.filter(Boolean).length, 24, 'the share is 24');

  // Bare connections that never start a handshake are held to it the same way.
  const bare = await limitedListener(t, {});
  const waiting = await Promise.all(Array.from({ length: 40 }, () => bare.tcp()));
  assert.equal(waiting.filter(Boolean).length, 24, 'a device cannot hold slots by never finishing its handshake');
});

test('a connection gives its share back when it closes, and a paired runner\'s as soon as it shows its certificate', async (t) => {
  const [stranger, runner] = await Promise.all([createDeviceCertificate(), createDeviceCertificate()]
    .map(async (made) => deviceIdentity(await made)));
  const limited = await limitedListener(t, { limits: { total: 100, unpairedPerSource: 3 }, paired: runner });
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => limited.tls(stranger))), [true, true, true]);
  assert.equal(await limited.tls(stranger), false, 'the share is full');
  limited.open[0].destroy();
  await delay(100);
  assert.equal(await limited.tls(stranger), true, 'a closed connection gave its slot back');

  // A runner's MCP processes open many, one after another: none is held to its address's share.
  const second = await limitedListener(t, { limits: { total: 100, unpairedPerSource: 3 }, paired: runner });
  const runners = [];
  for (let index = 0; index < 10; index += 1) runners.push(await second.tls(runner));
  assert.ok(runners.every(Boolean), 'a paired runner is not held to the share');
});

test('the total counts the connections of every address together', async (t) => {
  const runner = deviceIdentity(await createDeviceCertificate());
  const limited = await limitedListener(t, { limits: { total: 4, unpairedPerSource: 100 }, paired: runner,
    addresses: ['127.0.0.1', '::1'] });
  if (!limited.listener.addresses.includes('::1')) return t.skip('no IPv6 loopback to bind here');
  const held = [await limited.tls(runner), await limited.tls(runner), await limited.tls(runner, '::1'),
    await limited.tls(runner, '::1')];
  assert.deepEqual(held, [true, true, true, true]);
  assert.equal(await limited.tls(runner, '::1'), false, 'two addresses share one total');
  assert.equal(await limited.tls(runner), false);
});
