import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createNearbyPairing } from '../packages/roundtable/src/peer/nearby-pairing.js';

const authority = { keyId: 'a'.repeat(32), publicKey: Buffer.alloc(32, 7).toString('base64url') };
const nonceFrom = (seed) => { let count = 0; return () => Buffer.alloc(32, seed + count++).toString('base64url'); };
const sha = (text) => createHash('sha256').update(text).digest('hex');

// One computer's pairing with fake trust records; connect() reaches another
// computer's routes in this process, presenting this computer's certificate.
function computer(name, digit, { clock, coordinatesOthers = false, seed = digit, listening = () => true } = {}) {
  const self = { fingerprint: String(digit).repeat(64), certPem: `synthetic certificate ${name}`, address: `10.0.0.${digit}` };
  const record = { name, self, trusted: [], joined: [], paired: [] };
  record.local = {
    identity: async () => self, authority: async () => authority, name: () => name,
    role: () => ({ listening: listening(), coordinatesOthers, listenPort: 4100 }),
    trusted: (fingerprint) => record.trusted.some((peer) => peer.fingerprint === fingerprint),
    trustDevice: (peer) => { record.trusted.push(peer); },
    untrustDevice: async (fingerprint) => { record.trusted = record.trusted.filter((peer) => peer.fingerprint !== fingerprint); },
    joinCoordinator: async (peer) => { record.joined.push(peer); },
    reachable: async () => true,
  };
  record.pairing = createNearbyPairing({ local: record.local,
    connect: async (target) => ({ fingerprint: target.self.fingerprint, certPem: target.self.certPem, address: target.self.address, port: 4100,
      post: async (path, body) => {
        const { value, after } = await target.pairing.handle(path, body, self);
        after?.();
        return value;
      },
      close() {} }),
    clock, nonce: nonceFrom(seed * 10), pollMs: 5, onPaired: (peer) => record.paired.push(peer.fingerprint) });
  return record;
}

const listed = (target) => ({ ...target, fingerprint: target.self.fingerprint.slice(0, 16), shortFingerprint: 'AAAA',
  addresses: [target.self.address], port: 4100 });

async function settled(record, state) {
  for (let index = 0; index < 200; index += 1) {
    if (record.pairing.view()?.state === state) return record.pairing.view();
    await delay(5);
  }
  throw new Error(`${record.name} never reached ${state}: ${JSON.stringify(record.pairing.view())}`);
}

// A request the way a device in the middle would send it: commit, read the target's nonce, cancel.
async function reroll(target, attacker, index) {
  const nonce = createHash('sha256').update(String(index)).digest('base64url');
  const { value } = await target.pairing.handle('/peer/1/nearby/request', { protocol: 1, commit: sha(`fuli-pair-commit:1:${nonce}`),
    name: 'Desk', authority, coordinates: false }, attacker);
  await target.pairing.handle('/peer/1/nearby/poll', { requestId: value.requestId, cancel: true }, attacker);
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
  assert.equal(laptop.pairing.budget().unfinished, 1, 'an expired request counts');
  now += 2 * 60_000 + 1;
  assert.equal(laptop.pairing.view(), null, 'the expired request is forgotten');
});

test('a third device cannot complete or downgrade a pairing on its own', async () => {
  const laptop = computer('Laptop', 2);
  const strangers = [3, 4, 5].map((digit) => computer('Stranger', digit).self);
  const request = { protocol: 1, commit: 'c'.repeat(64), name: 'Stranger', authority, coordinates: false };
  for (const [index, protocol] of [0, 2, undefined].entries()) {
    await assert.rejects(laptop.pairing.handle('/peer/1/nearby/request', { ...request, protocol }, strangers[index]), { code: 'unsupported_protocol' });
  }
  const stranger = computer('Stranger', 6).self;
  const { value } = await laptop.pairing.handle('/peer/1/nearby/request', request, stranger);
  // The person here sees who asks as soon as the request exists.
  assert.deepEqual([laptop.pairing.view().direction, laptop.pairing.view().state, laptop.pairing.view().device.name],
    ['incoming', 'connecting', 'Stranger']);
  // A poll that claims a confirmation, before any code and without the person here, trusts nothing.
  assert.equal((await laptop.pairing.handle('/peer/1/nearby/poll', { requestId: value.requestId, confirmed: true }, stranger)).value.state, 'connecting');
  // Another certificate cannot act on this request at all.
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/poll', { requestId: value.requestId, confirmed: true },
    { fingerprint: '9'.repeat(64), certPem: 'other', address: '10.0.0.9' }), { code: 'pairing_not_found' });
  // A nonce that does not match the commitment ends the request.
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/reveal', { requestId: value.requestId, nonce: 'n'.repeat(43) }, stranger),
    { code: 'pairing_mismatch' });
  assert.deepEqual([laptop.pairing.view().state, laptop.pairing.view().reason, laptop.pairing.view().code], ['failed', 'code_mismatch', null]);
  assert.deepEqual(laptop.trusted, []);
  assert.equal(laptop.pairing.budget().unfinished, 4);
});

test('a device in the middle shows a different code on each side', async () => {
  const desk = computer('Desk', 1);
  const laptop = computer('Laptop', 2);
  // The middle answers the desk as if it were the laptop and asks the laptop as if it were the desk.
  const middleAsTarget = computer('Laptop', 4);
  const middleAsInitiator = computer('Desk', 5);
  await desk.pairing.start(listed(middleAsTarget));
  await middleAsInitiator.pairing.start(listed(laptop));
  assert.notEqual(desk.pairing.view().code, laptop.pairing.view().code);
  assert.throws(() => laptop.pairing.confirm({ requestId: laptop.pairing.view().requestId, code: desk.pairing.view().code }),
    { code: 'code_mismatch' });
  assert.deepEqual(laptop.trusted, []);
});

test('security review: a target that answers paired before the person here confirmed is refused', async () => {
  const desk = computer('Desk', 1);
  const hostile = { self: { fingerprint: 'e'.repeat(64), certPem: 'hostile', address: '10.0.0.66' } };
  const answers = [];
  const pairing = createNearbyPairing({ local: desk.local, pollMs: 5,
    connect: async () => ({ fingerprint: hostile.self.fingerprint, certPem: 'hostile', address: '10.0.0.66', port: 4100, close() {},
      post: async (path, body) => {
        answers.push([path, body]);
        if (path.endsWith('/request')) return { protocol: 1, requestId: 'r1', nonce: 'A'.repeat(43), name: 'Laptop', authority, coordinator: 'target' };
        if (path.endsWith('/reveal')) return { state: 'confirm' };
        return { state: 'paired' };
      } }) });
  await pairing.start({ name: 'Laptop', fingerprint: 'eeeeeeeeeeeeeeee', shortFingerprint: 'EEEE', addresses: ['10.0.0.66'], port: 4100 });
  const view = await (async () => {
    for (let index = 0; index < 100 && pairing.view().state === 'confirm'; index += 1) await delay(5);
    return pairing.view();
  })();
  assert.deepEqual([view.state, view.reason, view.confirmedHere], ['failed', 'unconfirmed_answer', false]);
  assert.deepEqual([desk.joined, desk.trusted], [[], []], 'the desk joins nobody');
  assert.equal(pairing.budget().unfinished, 1, 'the early answer is counted');
});

test('security review: re-rolling the target nonce hits the budget, shows on screen, and resets only when nearby turns on again', async () => {
  const laptop = computer('Laptop', 2);
  const attacker = { fingerprint: 'f'.repeat(64), certPem: 'mallory', address: '10.0.0.66' };
  for (let index = 0; index < 3; index += 1) await reroll(laptop, attacker, index);
  await assert.rejects(reroll(laptop, attacker, 3), { code: 'pairing_rate_limited' });
  assert.equal(laptop.pairing.view().direction, 'incoming', 'the last request is still on the screen');
  // New certificates each time reach the ceiling for everyone.
  for (const [index, digit] of ['b', 'c', 'd'].entries()) {
    await reroll(laptop, { fingerprint: digit.repeat(64), certPem: 'rotated', address: '10.0.0.67' }, 10 + index);
  }
  assert.deepEqual(laptop.pairing.budget(), { unfinished: 6, limited: true });
  await assert.rejects(reroll(laptop, { fingerprint: 'a'.repeat(64), certPem: 'new', address: '10.0.0.68' }, 20), { code: 'pairing_rate_limited' });
  laptop.pairing.close();
  assert.deepEqual(laptop.pairing.budget(), { unfinished: 0, limited: false });
});

test('security review: bad requests from one device do not lock others out, and an unanswered request frees the slot in 10 s', async () => {
  let now = Date.parse('2026-11-13T09:00:00.000Z');
  const laptop = computer('Laptop', 2, { clock: () => now });
  const stranger = { fingerprint: 'd'.repeat(64), certPem: 's', address: '10.0.0.67' };
  for (let index = 0; index < 10; index += 1) await laptop.pairing.handle('/peer/1/nearby/request', { protocol: 9 }, stranger).catch(() => {});
  assert.equal(laptop.pairing.budget().unfinished, 3, 'one device and address counts at most 3');
  const request = { protocol: 1, commit: 'c'.repeat(64), name: 'Squatter', authority, coordinates: false };
  await laptop.pairing.handle('/peer/1/nearby/request', request, { ...stranger, fingerprint: 'b'.repeat(64) });
  const desk = { fingerprint: '1'.repeat(64), certPem: 'a', address: '10.0.0.5' };
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/request', { ...request, name: 'Desk' }, desk), { code: 'pairing_busy' });
  now += 10_001;
  assert.deepEqual([laptop.pairing.view().state, laptop.pairing.view().reason], ['failed', 'no_answer']);
  assert.ok((await laptop.pairing.handle('/peer/1/nearby/request', { ...request, name: 'Desk' }, { ...desk, fingerprint: '7'.repeat(64) })).value.requestId);
});

test('nothing is answered or counted while nearby pairing is off', async () => {
  let listening = false;
  const laptop = computer('Laptop', 2, { listening: () => listening });
  for (let index = 0; index < 8; index += 1) {
    await assert.rejects(laptop.pairing.handle('/peer/1/nearby/request', { protocol: 9 }, computer('Stranger', 3).self), { code: 'nearby_off' });
  }
  listening = true;
  assert.deepEqual(laptop.pairing.budget(), { unfinished: 0, limited: false });
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
  await delay(5);
  assert.deepEqual([desk.paired, laptop.paired], [[laptop.self.fingerprint], [desk.self.fingerprint]]);
  assert.deepEqual([desk.pairing.budget().unfinished, laptop.pairing.budget().unfinished], [0, 0]);
});

test('when the initiator coordinates, the target joins only after the initiator trusted it', async () => {
  const desk = computer('Desk', 1, { coordinatesOthers: true });
  const laptop = computer('Laptop', 2);
  await desk.pairing.start(listed(laptop));
  const { requestId, code } = laptop.pairing.view();
  desk.pairing.confirm({ requestId: desk.pairing.view().requestId, code });
  laptop.pairing.confirm({ requestId, code });
  await settled(desk, 'paired');
  await settled(laptop, 'paired');
  assert.deepEqual([desk.trusted.map((peer) => peer.fingerprint), laptop.joined.map((peer) => peer.fingerprint)],
    [[laptop.self.fingerprint], [desk.self.fingerprint]]);
});
