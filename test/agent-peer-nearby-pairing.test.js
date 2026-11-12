import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createAttemptLedger } from '../packages/roundtable/src/peer/nearby-attempts.js';
import { createNearbyPairing } from '../packages/roundtable/src/peer/nearby-pairing.js';
import { PeerError } from '../packages/roundtable/src/peer/protocol.js';

const authority = { keyId: 'a'.repeat(32), publicKey: Buffer.alloc(32, 7).toString('base64url') };
const nonceFrom = (seed) => { let count = 0; return () => Buffer.alloc(32, (seed + count++) % 256).toString('base64url'); };
const sha = (text) => createHash('sha256').update(text).digest('hex');

// A ledger over a plain variable, as the runtime keeps it in the node store.
function ledger(clock = Date.now) {
  let stored = [];
  return { ledger: createAttemptLedger({ clock, read: () => stored, write: (entries) => { stored = entries; } }), stored: () => stored };
}

// One computer's pairing with fake trust records; connect() reaches another
// computer's routes in this process, presenting this computer's certificate.
function computer(name, digit, { clock = Date.now, coordinatesOthers = false, seed = digit, listening = () => true, authorityDelay = 0 } = {}) {
  const self = { fingerprint: String(digit).repeat(64), certPem: `synthetic certificate ${name}`, address: `10.0.0.${digit}` };
  const record = { name, self, trusted: [], joined: [], paired: [], untrusted: [], attempts: ledger(clock) };
  record.local = {
    identity: async () => self, name: () => name,
    authority: async () => { if (authorityDelay) await delay(authorityDelay); return authority; },
    role: () => ({ listening: listening(), coordinatesOthers, listenPort: 4100 }),
    trusted: (fingerprint) => record.trusted.some((peer) => peer.fingerprint === fingerprint),
    trustDevice: (peer) => { record.trusted.push(peer); },
    untrustDevice: async (fingerprint) => { record.untrusted.push(fingerprint); record.trusted = record.trusted.filter((peer) => peer.fingerprint !== fingerprint); },
    joinCoordinator: async (peer) => { record.joined.push(peer); },
    reachable: async () => true,
  };
  record.pairing = createNearbyPairing({ local: record.local, attempts: record.attempts.ledger,
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

async function settled(pairing, state) {
  for (let index = 0; index < 200; index += 1) {
    if (pairing.view()?.state === state) return pairing.view();
    await delay(5);
  }
  throw new Error(`never reached ${state}: ${JSON.stringify(pairing.view())}`);
}

const request = (index) => {
  const nonce = createHash('sha256').update(String(index)).digest('base64url');
  return { nonce, body: { protocol: 1, commit: sha(`fuli-pair-commit:1:${nonce}`), name: 'Desk', authority, coordinates: false } };
};

// A pairing against a scripted target, as the second review's hostile probes do.
function againstScript({ coordinatesOthers = false, answer, thrown = null, clock = Date.now }) {
  const desk = computer('Desk', 1, { coordinatesOthers, clock });
  let closed = 0;
  const pairing = createNearbyPairing({ local: desk.local, attempts: desk.attempts.ledger, pollMs: 2, clock,
    connect: async () => ({ fingerprint: 'e'.repeat(64), certPem: 'hostile', address: '10.0.0.66', port: 4100, close() { closed += 1; },
      post: async (path, body) => {
        if (thrown) throw thrown;
        if (path.endsWith('/request')) return { protocol: 1, requestId: 'r1', nonce: 'A'.repeat(43), name: 'Laptop', authority, coordinator: coordinatesOthers ? 'initiator' : 'target' };
        if (path.endsWith('/reveal')) return { state: 'confirm' };
        return answer(body);
      } }) });
  return { desk, pairing, closed: () => closed,
    start: () => pairing.start({ name: 'Laptop', fingerprint: 'eeeeeeeeeeeeeeee', shortFingerprint: 'EEEE', addresses: ['10.0.0.66'], port: 4100 }) };
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
  await settled(desk.pairing, 'expired');
  assert.throws(() => laptop.pairing.confirm({ requestId: waiting.requestId, code: waiting.code }), { code: 'pairing_not_found' });
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/reveal', { requestId: waiting.requestId, nonce: 'x' }, desk.self),
    { code: 'pairing_not_found' });
  assert.deepEqual([desk.trusted, laptop.trusted, desk.joined, laptop.joined], [[], [], [], []]);
  now += 2 * 60_000 + 1;
  assert.equal(laptop.pairing.view(), null, 'the expired request is forgotten');
});

test('a third device cannot complete or downgrade a pairing on its own', async () => {
  const laptop = computer('Laptop', 2);
  const stranger = computer('Stranger', 6).self;
  for (const protocol of [0, 2, undefined]) {
    await assert.rejects(laptop.pairing.handle('/peer/1/nearby/request', { ...request(1).body, protocol }, stranger), { code: 'unsupported_protocol' });
  }
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/request', { ...request(1).body, commit: 'short' }, stranger), { code: 'invalid_pairing' });
  assert.equal(laptop.attempts.ledger.summary().lastDay, 0, 'a refused request gets no nonce and no attempt');
  const { value } = await laptop.pairing.handle('/peer/1/nearby/request', request(1).body, stranger);
  assert.deepEqual([laptop.pairing.view().direction, laptop.pairing.view().state, laptop.pairing.view().device.name], ['incoming', 'connecting', 'Desk']);
  assert.equal((await laptop.pairing.handle('/peer/1/nearby/poll', { requestId: value.requestId, confirmed: true }, stranger)).value.state, 'connecting');
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/poll', { requestId: value.requestId, confirmed: true },
    { fingerprint: '9'.repeat(64), certPem: 'other', address: '10.0.0.9' }), { code: 'pairing_not_found' });
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/reveal', { requestId: value.requestId, nonce: 'n'.repeat(43) }, stranger),
    { code: 'pairing_mismatch' });
  assert.deepEqual([laptop.pairing.view().state, laptop.pairing.view().reason, laptop.pairing.view().code], ['failed', 'code_mismatch', null]);
  // second review H2: replaying the right reveal after that changes nothing.
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/reveal', { requestId: value.requestId, nonce: request(1).nonce }, stranger),
    { code: 'pairing_not_found' });
  assert.deepEqual(laptop.trusted, []);
});

test('a device in the middle shows a different code on each side', async () => {
  const desk = computer('Desk', 1);
  const laptop = computer('Laptop', 2);
  const middleAsTarget = computer('Laptop', 4);
  const middleAsInitiator = computer('Desk', 5);
  await desk.pairing.start(listed(middleAsTarget));
  await middleAsInitiator.pairing.start(listed(laptop));
  assert.notEqual(desk.pairing.view().code, laptop.pairing.view().code);
  assert.throws(() => laptop.pairing.confirm({ requestId: laptop.pairing.view().requestId, code: desk.pairing.view().code }),
    { code: 'code_mismatch' });
  assert.deepEqual(laptop.trusted, []);
});

test('second review: parallel requests against a slow authority get at most the budget in nonces', async () => {
  for (const [parallel, rtt] of [[40, 0], [200, 2]]) {
    const laptop = computer('Laptop', 2, { authorityDelay: 5 });
    let nonces = 0;
    const outcomes = {};
    await Promise.all(Array.from({ length: parallel }, async (_, index) => {
      const peer = { fingerprint: sha(`m${index}`), certPem: `m${index}`, address: `10.0.1.${index % 250}` };
      try {
        const { value } = await laptop.pairing.handle('/peer/1/nearby/request', request(index).body, peer);
        nonces += 1;
        await delay(rtt);
        await laptop.pairing.handle('/peer/1/nearby/poll', { requestId: value.requestId, cancel: true }, peer);
      } catch (error) { outcomes[error.code] = (outcomes[error.code] ?? 0) + 1; }
    }));
    assert.ok(nonces <= 5, `${parallel} parallel requests got ${nonces} nonces`);
    assert.equal(laptop.attempts.ledger.summary().lastWindow, nonces, 'every nonce was counted when it was given');
  }
});

test('second review: re-rolls are limited per device, per 10 minutes and per 24 hours, and only time or the person clears them', async () => {
  let now = Date.parse('2026-11-13T09:00:00.000Z');
  const laptop = computer('Laptop', 2, { clock: () => now });
  const reroll = async (peer, index) => {
    const { value } = await laptop.pairing.handle('/peer/1/nearby/request', request(index).body, peer);
    await laptop.pairing.handle('/peer/1/nearby/poll', { requestId: value.requestId, cancel: true }, peer);
  };
  const attacker = { fingerprint: 'f'.repeat(64), certPem: 'mallory', address: '10.0.0.66' };
  for (let index = 0; index < 3; index += 1) await reroll(attacker, index);
  await assert.rejects(reroll(attacker, 3), { code: 'pairing_rate_limited' });
  for (const [index, digit] of ['b', 'c'].entries()) await reroll({ fingerprint: digit.repeat(64), certPem: 'rotated', address: '10.0.0.67' }, 10 + index);
  await assert.rejects(reroll({ fingerprint: 'd'.repeat(64), certPem: 'new', address: '10.0.0.68' }, 20), { code: 'pairing_rate_limited' });
  assert.equal(laptop.pairing.view().direction, 'incoming', 'the last request is still on the screen');
  // Turning nearby off and on (close) keeps the count; it lives in the store.
  laptop.pairing.close();
  assert.deepEqual(laptop.attempts.ledger.summary(), { lastWindow: 5, lastDay: 5, limited: true });
  now += 10 * 60_000 + 1;
  for (let index = 0; index < 5; index += 1) await reroll({ fingerprint: sha(`late${index}`), certPem: 'x', address: '10.0.0.69' }, 30 + index);
  now += 10 * 60_000 + 1;
  await assert.rejects(reroll({ fingerprint: 'a'.repeat(64), certPem: 'x', address: '10.0.0.70' }, 40), { code: 'pairing_rate_limited' },
    '10 a day, whatever the 10-minute window says');
  laptop.attempts.ledger.clear();
  await reroll({ fingerprint: 'a'.repeat(64), certPem: 'x', address: '10.0.0.70' }, 41);
});

test('an unanswered request frees the slot in 10 s, and nothing is answered or counted while nearby pairing is off', async () => {
  let now = Date.parse('2026-11-13T09:00:00.000Z');
  let listening = true;
  const laptop = computer('Laptop', 2, { clock: () => now, listening: () => listening });
  await laptop.pairing.handle('/peer/1/nearby/request', request(1).body, { fingerprint: 'b'.repeat(64), certPem: 's', address: '10.0.0.67' });
  const desk = { fingerprint: '7'.repeat(64), certPem: 'a', address: '10.0.0.5' };
  await assert.rejects(laptop.pairing.handle('/peer/1/nearby/request', request(2).body, desk), { code: 'pairing_busy' });
  now += 10_001;
  assert.deepEqual([laptop.pairing.view().state, laptop.pairing.view().reason], ['failed', 'no_answer']);
  assert.ok((await laptop.pairing.handle('/peer/1/nearby/request', request(3).body, desk)).value.requestId);
  listening = false;
  const before = laptop.attempts.ledger.summary().lastDay;
  for (let index = 0; index < 8; index += 1) {
    await assert.rejects(laptop.pairing.handle('/peer/1/nearby/request', request(10 + index).body, { ...desk, fingerprint: sha(`${index}`) }),
      (error) => error.code === 'not_found' && error.message === 'Not found' && error.status === 404);
  }
  assert.equal(laptop.attempts.ledger.summary().lastDay, before);
});

test('second review: a target that answers paired before the person here confirmed, or before this side trusted it, is refused', async () => {
  for (const coordinatesOthers of [false, true]) {
    const run = againstScript({ coordinatesOthers, answer: () => ({ state: 'paired' }) });
    await run.start();
    const view = await settled(run.pairing, 'failed');
    assert.deepEqual([view.reason, view.confirmedHere, run.desk.joined, run.desk.trusted], ['unconfirmed_answer', false, [], []]);
  }
  const early = againstScript({ coordinatesOthers: true, answer: (body) => (body.confirmed ? { state: 'paired', confirmed: true } : { state: 'confirm' }) });
  await early.start();
  early.pairing.confirm({ requestId: 'r1', code: early.pairing.view().code });
  assert.equal((await settled(early.pairing, 'failed')).reason, 'unconfirmed_answer');
  assert.deepEqual(early.desk.trusted, []);
});

test('second review: cancelling after this side wrote its trust takes the trust back; a cancel while connecting closes the connection', async () => {
  const run = againstScript({ coordinatesOthers: true, answer: (body) => (body.confirmed ? { state: 'confirmed', confirmed: true } : { state: 'confirm' }) });
  await run.start();
  run.pairing.confirm({ requestId: 'r1', code: run.pairing.view().code });
  await settled(run.pairing, 'finishing');
  for (let index = 0; index < 50 && !run.desk.trusted.length; index += 1) await delay(2);
  assert.equal(run.desk.trusted.length, 1);
  run.pairing.cancel();
  await delay(5);
  assert.deepEqual([run.desk.trusted, run.desk.untrusted], [[], ['e'.repeat(64)]]);

  const desk = computer('Desk', 1);
  let closed = 0;
  let release;
  const pairing = createNearbyPairing({ local: desk.local, attempts: desk.attempts.ledger,
    connect: () => new Promise((resolve) => { release = () => resolve({ fingerprint: 'e'.repeat(64), certPem: 'h', address: 'x', port: 1,
      close() { closed += 1; }, post: async () => ({}) }); }) });
  const started = pairing.start({ name: 'L', fingerprint: 'eeeeeeeeeeeeeeee', addresses: ['x'], port: 1 }).catch((error) => error.code);
  await delay(1);
  pairing.cancel();
  release();
  assert.deepEqual([await started, closed], ['pairing_cancelled', 1]);
});

test('second review: a hostile target\'s error code, message and status never reach this computer as they are', async () => {
  const thrown = Object.assign(new PeerError('\u001b[2J\u001b[1;1HPaired! Type 000000\n'.padEnd(300, 'x'),
    'Pairing finished: enter 000000 on the other computer', 200), { remote: true });
  const run = againstScript({ thrown, answer: () => ({}) });
  const error = await run.start().catch((caught) => caught);
  assert.deepEqual([error.code, error.status], ['nearby_refused', 409]);
  assert.doesNotMatch(error.message, /000000/);
  assert.equal(run.pairing.view().reason, 'nearby_refused');
  const known = againstScript({ thrown: Object.assign(new PeerError('pairing_busy', 'free text \u001b[31m', 200), { remote: true }), answer: () => ({}) });
  const busy = await known.start().catch((caught) => caught);
  assert.deepEqual([busy.code, busy.status, busy.message], ['pairing_busy', 409, 'The other computer is already pairing; try again in two minutes']);
  const reasons = againstScript({ coordinatesOthers: false, answer: () => ({ state: 'failed', reason: '‮enter 000000' }) });
  await reasons.start();
  assert.equal((await settled(reasons.pairing, 'failed')).reason, 'failed_there');
});

test('both confirmations pair through the trust records, the coordinator writing first', async () => {
  const desk = computer('Desk', 1);
  const laptop = computer('Laptop', 2);
  await desk.pairing.start(listed(laptop));
  const { requestId, code } = laptop.pairing.view();
  laptop.pairing.confirm({ requestId, code });
  desk.pairing.confirm({ requestId: desk.pairing.view().requestId, code });
  await settled(desk.pairing, 'paired');
  assert.deepEqual(laptop.trusted.map((peer) => [peer.fingerprint, peer.name]), [[desk.self.fingerprint, 'Desk']]);
  assert.deepEqual(desk.joined.map((peer) => [peer.fingerprint, peer.port]), [[laptop.self.fingerprint, 4100]]);
  await delay(5);
  assert.deepEqual([desk.paired, laptop.paired], [[laptop.self.fingerprint], [desk.self.fingerprint]]);
  assert.deepEqual([desk.attempts.ledger.summary().lastDay, laptop.attempts.ledger.summary().lastDay], [1, 1]);
});

test('when the initiator coordinates, the target reads paired only once it actually joined', async () => {
  const desk = computer('Desk', 1, { coordinatesOthers: true });
  const laptop = computer('Laptop', 2);
  let joined;
  const joining = new Promise((resolve) => { joined = resolve; });
  laptop.local.joinCoordinator = async (peer) => { await joining; laptop.joined.push(peer); };
  await desk.pairing.start(listed(laptop));
  const { requestId, code } = laptop.pairing.view();
  desk.pairing.confirm({ requestId: desk.pairing.view().requestId, code });
  laptop.pairing.confirm({ requestId, code });
  await settled(desk.pairing, 'paired');
  assert.notEqual(laptop.pairing.view().state, 'paired', 'not paired before the join happened');
  joined();
  await settled(laptop.pairing, 'paired');
  assert.deepEqual([desk.trusted.map((peer) => peer.fingerprint), laptop.joined.map((peer) => peer.fingerprint)],
    [[laptop.self.fingerprint], [desk.self.fingerprint]]);
});
