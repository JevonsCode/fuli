import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createNearbyPairing } from '../packages/roundtable/src/peer/nearby-pairing.js';

const authority = { keyId: 'a'.repeat(32), publicKey: Buffer.alloc(32, 7).toString('base64url') };
const nonceFrom = (seed) => { let count = 0; return () => Buffer.alloc(32, seed + count++).toString('base64url'); };

// One computer's pairing with fake trust records; connect() reaches another
// computer's routes in this process, presenting this computer's certificate.
function computer(name, digit, { clock, coordinatesOthers = false, seed = digit } = {}) {
  const self = { fingerprint: String(digit).repeat(64), certPem: `synthetic certificate ${name}` };
  const record = { name, self, trusted: [], joined: [] };
  record.pairing = createNearbyPairing({
    local: {
      identity: async () => self, authority: async () => authority, name: () => name,
      role: () => ({ listening: true, coordinatesOthers, listenPort: 4100 }),
      trusted: (fingerprint) => record.trusted.some((peer) => peer.fingerprint === fingerprint),
      trustDevice: (peer) => { record.trusted.push(peer); },
      untrustDevice: async (fingerprint) => { record.trusted = record.trusted.filter((peer) => peer.fingerprint !== fingerprint); },
      joinCoordinator: async (peer) => { record.joined.push(peer); },
      reachable: async () => true,
    },
    connect: async (target) => ({ fingerprint: target.self.fingerprint, certPem: target.self.certPem, address: '127.0.0.1', port: 4100,
      post: async (path, body) => {
        const { value, after } = await target.pairing.handle(path, body, { ...self, address: '127.0.0.1' });
        after?.();
        return value;
      },
      close() {} }),
    clock, nonce: nonceFrom(seed * 10), pollMs: 5,
  });
  return record;
}

const listed = (target) => ({ ...target, shortFingerprint: 'AAAA', addresses: ['127.0.0.1'], port: 4100 });

async function settled(record, state) {
  for (let index = 0; index < 200; index += 1) {
    if (record.pairing.view()?.state === state) return record.pairing.view();
    await delay(5);
  }
  throw new Error(`${record.name} never reached ${state}: ${JSON.stringify(record.pairing.view())}`);
}

test('an unconfirmed nearby pairing expires after two minutes and leaves nothing behind', async () => {
  let now = Date.parse('2026-11-13T09:00:00.000Z');
  const clock = () => now;
  const desk = computer('Desk', 1, { clock });
  const laptop = computer('Laptop', 2, { clock });
  await desk.pairing.start(listed(laptop));
  const waiting = laptop.pairing.view();
  assert.equal(waiting.state, 'confirm');
  assert.equal(waiting.code, desk.pairing.view().code);
  desk.pairing.confirm({ requestId: desk.pairing.view().requestId, code: waiting.code });

  now += 2 * 60_000 + 1;
  assert.deepEqual([laptop.pairing.view().state, laptop.pairing.view().code], ['expired', null]);
  await settled(desk, 'expired');
  assert.throws(() => laptop.pairing.confirm({ requestId: waiting.requestId, code: waiting.code }), { code: 'pairing_not_found' });
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/reveal', { requestId: waiting.requestId, nonce: 'x' }, desk.self),
    { code: 'pairing_not_found' });
  assert.deepEqual([desk.trusted, laptop.trusted, desk.joined, laptop.joined], [[], [], [], []]);
  now += 2 * 60_000 + 1;
  assert.equal(laptop.pairing.view(), null, 'the expired request is forgotten');
});

test('a third device cannot complete or downgrade a pairing on its own', async () => {
  const laptop = computer('Laptop', 2);
  const stranger = computer('Stranger', 3);
  const request = { protocol: 1, commit: 'c'.repeat(64), name: 'Stranger', authority, coordinates: false };
  for (const protocol of [0, 2, undefined]) {
    await assert.rejects(laptop.pairing.handle('/peer/1/nearby/request', { ...request, protocol }, stranger.self), { code: 'unsupported_protocol' });
  }
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/request', { ...request, commit: 'short' }, stranger.self), { code: 'invalid_pairing' });

  const { value } = await laptop.pairing.handle('/peer/1/nearby/request', request, stranger.self);
  // A poll that claims a confirmation, before any code and without the person here, trusts nothing.
  assert.equal((await laptop.pairing.handle('/peer/1/nearby/poll', { requestId: value.requestId, confirmed: true }, stranger.self)).value.state, 'connecting');
  // Another certificate cannot act on this request at all.
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/poll', { requestId: value.requestId, confirmed: true },
    { fingerprint: '9'.repeat(64), certPem: 'other' }), { code: 'pairing_not_found' });
  // A nonce that does not match the commitment ends the request.
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/reveal', { requestId: value.requestId, nonce: 'n'.repeat(43) }, stranger.self),
    { code: 'pairing_mismatch' });
  assert.deepEqual([laptop.pairing.view().state, laptop.pairing.view().reason, laptop.pairing.view().code], ['failed', 'code_mismatch', null]);
  assert.deepEqual(laptop.trusted, []);
});

test('a device in the middle shows a different code on each side', async () => {
  const desk = computer('Desk', 1);
  const laptop = computer('Laptop', 2);
  // The middle answers the desk as if it were the laptop and asks the laptop as if it were the desk.
  const middleAsTarget = computer('Laptop', 4);
  const middleAsInitiator = computer('Desk', 5);
  await desk.pairing.start(listed(middleAsTarget));
  await middleAsInitiator.pairing.start(listed(laptop));
  assert.equal(desk.pairing.view().state, 'confirm');
  assert.equal(laptop.pairing.view().state, 'confirm');
  assert.notEqual(desk.pairing.view().code, laptop.pairing.view().code);
  // The person on the laptop types the code the desk shows: the pairing ends there.
  assert.throws(() => laptop.pairing.confirm({ requestId: laptop.pairing.view().requestId, code: desk.pairing.view().code }),
    { code: 'code_mismatch' });
  assert.deepEqual(laptop.trusted, []);
});

test('repeated failed pairing attempts are rate-limited', async () => {
  const laptop = computer('Laptop', 2);
  const stranger = computer('Stranger', 3);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await assert.rejects(laptop.pairing.handle('/peer/1/nearby/request', { protocol: 9 }, stranger.self), { code: 'unsupported_protocol' });
  }
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/request', { protocol: 1 }, stranger.self), { code: 'pairing_rate_limited' });
});

test('both confirmations pair through the trust records, the coordinator writing first', async () => {
  const desk = computer('Desk', 1);
  const laptop = computer('Laptop', 2);
  await desk.pairing.start(listed(laptop));
  const { requestId, code } = laptop.pairing.view();
  laptop.pairing.confirm({ requestId, code });
  desk.pairing.confirm({ requestId: desk.pairing.view().requestId, code });
  await settled(desk, 'paired');
  assert.deepEqual(laptop.trusted.map((peer) => [peer.fingerprint, peer.name]), [[desk.self.fingerprint, 'Desk']]);
  assert.deepEqual(desk.joined.map((peer) => [peer.fingerprint, peer.port]), [[laptop.self.fingerprint, 4100]]);
  assert.deepEqual([desk.trusted, laptop.joined], [[], []]);
});
