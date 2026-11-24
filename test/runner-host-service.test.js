import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { createRunnerHost } from '../src/runner/host-service.js';
import { parseInvitation } from '../src/runner/protocol.js';

// The host closes before its folder is removed: Windows refuses to delete a
// SQLite file that is still open, so a host that kept one would fail here.
function hostFixture(t, { addresses = ['192.168.1.20'] } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fuli-runner-host-'));
  const listeners = [];
  const host = createRunnerHost({ app: {}, dataDir, discoverAddresses: () => addresses,
    loadIdentity: async () => deviceIdentity(await createDeviceCertificate()),
    startListener: async ({ addresses: bound, port }) => {
      const listener = { addresses: bound, port, closed: false,
        rebind: async (next) => { listener.addresses = next; }, close: async () => { listener.closed = true; } };
      listeners.push(listener);
      return listener;
    },
    createDiscovery: () => ({ advertise: () => ({ stop: () => {} }), close: () => {} }) });
  t.after(async () => {
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { host, listeners, dataDir };
}

test('an invitation starts the listener and names where the host is and how it proves itself', async (t) => {
  const { host, listeners } = hostFixture(t);
  assert.equal(host.list().listening, false);

  const invited = await host.invite({ name: 'Office laptop' });
  const invitation = parseInvitation(invited.invitation);

  assert.equal(invited.ok, true);
  assert.deepEqual(invitation.addresses, ['192.168.1.20']);
  assert.equal(invitation.port, 2730);
  assert.equal(invitation.fingerprint, host.list().fingerprint);
  assert.equal(listeners.length, 1);
  assert.equal(host.list().listening, true);
});

test('without a network an invitation says so instead of naming an address', async (t) => {
  const { host } = hostFixture(t, { addresses: [] });
  assert.deepEqual(await host.invite({}), { ok: false, code: 'no_network' });
});

test('revoking needs a fingerprint that names exactly one paired runner', async (t) => {
  const { host } = hostFixture(t);
  assert.deepEqual(await host.revoke('abc'), { ok: false, code: 'runner_unknown' });
  assert.deepEqual(await host.revoke('0123456789abcdef'), { ok: false, code: 'runner_unknown' });
});

test('a host that never invited opens no store and no listener', async (t) => {
  const { host, listeners, dataDir } = hostFixture(t);
  await host.start();
  assert.equal(host.list().runners.length, 0);
  assert.equal(existsSync(path.join(dataDir, 'runner')), false);
  assert.equal(listeners.length, 0);
});

test('closing the host ends its listener and releases its files', async (t) => {
  const { host, listeners, dataDir } = hostFixture(t);
  await host.invite({ name: 'Office laptop' });
  assert.equal(existsSync(path.join(dataDir, 'runner', 'host.sqlite')), true);

  await host.close();
  assert.equal(listeners[0].closed, true);
  rmSync(path.join(dataDir, 'runner'), { recursive: true });
  host.list();
  assert.equal(existsSync(path.join(dataDir, 'runner')), false, 'nothing opens the store again after close');
});
