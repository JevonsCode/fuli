import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { startCoordinatorServer } from '../packages/roundtable/src/peer/coordinator-http.js';
import { createCoordinatorService } from '../packages/roundtable/src/peer/coordinator-service.js';
import { createCoordinatorStore } from '../packages/roundtable/src/peer/coordinator-store.js';
import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { createPeerRuntime } from '../packages/roundtable/src/peer/peer-runtime.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { device, discoveryBus, pair, remoteAddress } from './fixtures/peer-devices.js';

// Polls a runtime's status until it matches; a real pairing runs over TLS on loopback.
async function until(runtime, matches, label) {
  for (let index = 0; index < 200; index += 1) {
    const status = await runtime.status();
    if (matches(status)) return status;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function nearbyPair(initiator, target) {
  const seen = await until(initiator.runtime, (status) => status.nearby.devices.length > 0, 'the target to be listed');
  await initiator.runtime.pairNearby({ fingerprint: seen.nearby.devices[0].fingerprint.slice(0, 6) });
  const [here, there] = await Promise.all([
    until(initiator.runtime, (status) => status.nearby.pairing?.state === 'confirm', 'the initiator code'),
    until(target.runtime, (status) => status.nearby.pairing?.state === 'confirm', 'the target code'),
  ]);
  return { here: here.nearby.pairing, there: there.nearby.pairing };
}

test('nearby pairing is off by default: nothing is advertised, browsed or listened on', async () => {
  const bus = discoveryBus();
  const desk = await device('desk', { discovery: bus.discovery });
  try {
    await desk.runtime.resume();
    const status = await desk.runtime.status();
    assert.deepEqual([status.role, status.nearby.on, status.nearby.devices, status.nearby.pairing], [null, false, [], null]);
    assert.deepEqual([bus.adverts.size, bus.browsers.size], [0, 0]);
    await assert.rejects(desk.runtime.pairNearby({ fingerprint: 'abcd' }), { code: 'nearby_not_found' });
  } finally { await desk.close(); }
});

test('two computers pair from the nearby list with one 6-digit code and a confirmation on each', { timeout: 30_000 }, async () => {
  const bus = discoveryBus();
  const [desk, laptop] = await Promise.all([device('desk', { discovery: bus.discovery }), device('laptop', { discovery: bus.discovery })]);
  try {
    await desk.runtime.nearbyOn({ name: 'Desk' });
    await laptop.runtime.nearbyOn({ name: 'Laptop' });
    const [record] = [...bus.adverts.values()].filter((advert) => advert.txt.n === 'Desk');
    // Nothing private is advertised: a random instance id and host, the chosen name, port and version.
    assert.deepEqual(Object.keys(record.txt).sort(), ['fp', 'n', 'v']);
    assert.match(record.name, /^FULI [0-9a-f]{8}$/);
    assert.match(record.host, /^fuli-[0-9a-f]{8}\.local$/);

    const { here, there } = await nearbyPair(desk, laptop);
    assert.match(here.code, /^\d{6}$/);
    assert.equal(here.code, there.code, 'both computers show the same code');
    // The picked computer (the target) coordinates; nobody chose it.
    assert.deepEqual([here.coordinator, there.coordinator], ['other', 'this']);
    assert.equal(there.device.name, 'Desk');

    await desk.runtime.confirmPairing({ requestId: here.requestId, code: there.code, fingerprint: here.device.fingerprint.slice(0, 16) });
    await delay(150);
    assert.equal((await laptop.runtime.status()).devices.filter((entry) => !entry.self).length, 0, 'one confirmation trusts nothing');
    assert.equal((await desk.runtime.status()).role, 'coordinator', 'nothing changes before both confirmed');

    await laptop.runtime.confirmPairing({ requestId: there.requestId, code: here.code });
    const joined = await until(desk.runtime, (status) => status.role === 'member' && status.nearby.pairing?.state === 'paired', 'the desk to join');
    assert.equal(joined.coordinator.name, 'Laptop');
    const coordinator = await until(laptop.runtime, (status) => status.devices.some((entry) => !entry.self && entry.online), 'the desk to connect');
    assert.equal(coordinator.nearby.pairing.state, 'paired');
    assert.equal(coordinator.devices.find((entry) => !entry.self).name, 'Desk');
    // The joined computer no longer listens or advertises; the coordinator still does.
    assert.deepEqual([...bus.adverts.values()].map((advert) => advert.txt.n), ['Laptop']);
    assert.equal(joined.nearby.devices.find((entry) => entry.name === 'Laptop').paired, true);

    // The pairing is an ordinary one: a shared lead answers across the computers.
    await laptop.runtime.setShares({ shares: [{ projectId: laptop.projectId, clients: ['codex'], workingDirectory: laptop.folder }] });
    const answer = await desk.app.roundtable.messageAgent({ taskContextToken: 'desk-task', sourceApplication: 'codex',
      to: await remoteAddress(desk.app), body: 'Synthetic nearby question', timeoutSeconds: 30 });
    assert.equal(answer.status, 'answered', JSON.stringify(answer));
  } finally { await desk.close(); await laptop.close(); }
});

test('a code that differs cancels the pairing on both computers and trusts nothing', { timeout: 30_000 }, async () => {
  const bus = discoveryBus();
  const [desk, laptop] = await Promise.all([device('desk', { discovery: bus.discovery }), device('laptop', { discovery: bus.discovery })]);
  try {
    await desk.runtime.nearbyOn({ name: 'Desk' });
    await laptop.runtime.nearbyOn({ name: 'Laptop' });
    const { here, there } = await nearbyPair(desk, laptop);
    // A confirm that names another device, or too little of this one, is refused and leaves the request as it is.
    await assert.rejects(laptop.runtime.confirmPairing({ requestId: there.requestId, code: here.code, fingerprint: 'f'.repeat(16) }), { code: 'device_mismatch' });
    await assert.rejects(laptop.runtime.confirmPairing({ requestId: there.requestId, code: here.code, fingerprint: there.device.fingerprint.slice(0, 8) }), { code: 'device_mismatch' });
    assert.equal((await laptop.runtime.status()).nearby.pairing.state, 'confirm');
    const wrong = String((Number(here.code) + 1) % 1_000_000).padStart(6, '0');
    await assert.rejects(laptop.runtime.confirmPairing({ requestId: there.requestId, code: wrong }), { code: 'code_mismatch' });
    const ended = await until(desk.runtime, (status) => status.nearby.pairing?.state === 'failed', 'the initiator to see the mismatch');
    assert.deepEqual([ended.nearby.pairing.reason, ended.nearby.pairing.code], ['code_mismatch', null]);
    await assert.rejects(desk.runtime.confirmPairing({ requestId: here.requestId, code: here.code }), { code: 'pairing_not_found' });
    for (const runtime of [desk.runtime, laptop.runtime]) {
      const status = await runtime.status();
      assert.equal(status.role, 'coordinator');
      assert.deepEqual(status.devices.filter((entry) => !entry.self), []);
    }
  } finally { await desk.close(); await laptop.close(); }
});

test('turning nearby pairing off closes the listener it opened and stops advertising', { timeout: 20_000 }, async () => {
  const bus = discoveryBus();
  const desk = await device('desk', { discovery: bus.discovery });
  try {
    const on = await desk.runtime.nearbyOn({ name: 'Desk' });
    assert.deepEqual([on.role, on.nearby.on, on.nearby.canPair, bus.adverts.size, bus.browsers.size], ['coordinator', true, true, 1, 1]);
    const off = await desk.runtime.nearbyOff();
    assert.deepEqual([off.role, off.nearby.on, bus.adverts.size, bus.browsers.size], [null, false, 0, 0]);
  } finally { await desk.close(); }
});

test('a computer that coordinates others keeps doing so; the picked one joins it', { timeout: 30_000 }, async () => {
  const bus = discoveryBus();
  const [desk, laptop, tablet] = await Promise.all([device('desk', { discovery: bus.discovery }),
    device('laptop', { discovery: bus.discovery }), device('tablet')]);
  try {
    await pair(desk, tablet);
    await desk.runtime.nearbyOn({ name: 'Desk' });
    await laptop.runtime.nearbyOn({ name: 'Laptop' });
    const { here, there } = await nearbyPair(desk, laptop);
    assert.deepEqual([here.coordinator, there.coordinator], ['this', 'other']);
    await laptop.runtime.confirmPairing({ requestId: there.requestId, code: here.code });
    await desk.runtime.confirmPairing({ requestId: here.requestId, code: there.code });
    const member = await until(laptop.runtime, (status) => status.role === 'member', 'the laptop to join the desk');
    assert.equal(member.coordinator.shortFingerprint, (await desk.runtime.status()).device.shortFingerprint);
    await until(desk.runtime, (status) => status.devices.filter((entry) => !entry.self && entry.status === 'active').length === 2,
      'the desk to trust both devices');
  } finally { await desk.close(); await laptop.close(); await tablet.close(); }
});

// A folder that is a Git checkout whose origin is the given address.
async function checkout(origin) {
  const folder = await mkdtemp(join(tmpdir(), 'fuli-peer-checkout-'));
  await mkdir(join(folder, '.git'));
  await writeFile(join(folder, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`);
  return folder;
}

test('paired computers see the projects they share by their own repository; a folder is offered only from that repository', { timeout: 30_000 }, async () => {
  const repository = 'git@example.test:team/shared-app.git';
  const [matching, other] = await Promise.all([checkout(repository), checkout('git@example.test:team/other-app.git')]);
  const [desk, laptop, tablet] = await Promise.all([device('desk', { repository, sessionFolder: matching }),
    device('laptop', { repository: 'https://example.test/team/shared-app' }), device('tablet', { repository, sessionFolder: other })]);
  try {
    await pair(laptop, desk, { folder: false });
    await tablet.runtime.join({ invitation: laptop.runtime.createInvitation().invitation, name: 'Tablet' });
    const status = await until(desk.runtime, (entry) => entry.shareable[0]?.sameProjectOn.length === 2, 'the same project to show');
    assert.deepEqual(status.shareable[0].sameProjectOn.map((entry) => entry.name).sort(), ['Coordinator', 'Tablet']);
    assert.equal(status.shareable[0].knownFolder, matching, 'a checkout of the project\'s own repository');
    const elsewhere = await until(tablet.runtime, (entry) => entry.shareable[0]?.sameProjectOn.length === 2, 'the tablet to see it');
    assert.equal(elsewhere.shareable[0].knownFolder, null, 'a folder of another repository is never offered');
  } finally { await desk.close(); await laptop.close(); await tablet.close(); await rm(matching, { recursive: true }); await rm(other, { recursive: true }); }
});

test('the coordinator keeps repository digests to itself, keyed per paired group, and changes the key on revoke', async () => {
  const [coordinator, desk, laptop] = await Promise.all([1, 2, 3].map(async () => deviceIdentity(await createDeviceCertificate())));
  const store = createCoordinatorStore();
  const service = createCoordinatorService({ store, identity: coordinator, name: 'Coordinator',
    authority: { keyId: '0'.repeat(32), publicKey: Buffer.alloc(32).toString('base64url') } });
  for (const [entry, name] of [[desk, 'Desk'], [laptop, 'Laptop']]) {
    store.upsertNode({ id: entry.fingerprint, name, certPem: entry.certPem, at: new Date().toISOString() });
  }
  const { repositoryKey } = service.publishDirectory(desk.fingerprint, { agents: [] });
  assert.equal(repositoryKey.key.length >= 32, true);
  const shared = 'a'.repeat(32);
  service.publishDirectory(desk.fingerprint, { agents: [], repositories: { keyId: repositoryKey.id, digests: [shared, 'b'.repeat(32)] } });
  service.publishDirectory(laptop.fingerprint, { agents: [], repositories: { keyId: repositoryKey.id, digests: [shared, 'c'.repeat(32)] } });
  service.publishDirectory(laptop.fingerprint, { agents: [], repositories: { keyId: 'stale', digests: ['d'.repeat(32)] } });
  const seenByDesk = service.directory(desk.fingerprint).devices.find((entry) => entry.nodeId === laptop.fingerprint);
  assert.deepEqual(seenByDesk.sameRepositories, [shared], 'only what the desk itself sent and the laptop also has');
  assert.equal(JSON.stringify(service.directory(desk.fingerprint)).includes('c'.repeat(32)), false);
  // second review: a member can test few guesses: 50 digests per set, 3 new sets a day.
  const guesses = Array.from({ length: 60 }, (_, index) => index.toString(16).padStart(32, 'e'));
  service.publishDirectory(desk.fingerprint, { agents: [], repositories: { keyId: repositoryKey.id, digests: guesses } });
  service.publishDirectory(laptop.fingerprint, { agents: [], repositories: { keyId: repositoryKey.id, digests: [guesses[55], guesses[1]] } });
  assert.deepEqual(service.directory(desk.fingerprint).devices.find((entry) => entry.nodeId === laptop.fingerprint).sameRepositories, [guesses[1]]);
  service.publishDirectory(desk.fingerprint, { agents: [], repositories: { keyId: repositoryKey.id, digests: ['f'.repeat(32)] } });
  service.publishDirectory(desk.fingerprint, { agents: [], repositories: { keyId: repositoryKey.id, digests: ['9'.repeat(32)] } });
  service.publishDirectory(desk.fingerprint, { agents: [], repositories: { keyId: repositoryKey.id, digests: [guesses[55]] } });
  assert.deepEqual(service.directory(desk.fingerprint).devices.find((entry) => entry.nodeId === laptop.fingerprint).sameRepositories, [],
    'a fourth new set in a day under one key is not taken (the first set under a key is free)');
  service.revoke(laptop.fingerprint);
  assert.notEqual(service.publishDirectory(desk.fingerprint, { agents: [] }).repositoryKey.id, repositoryKey.id);
  store.close();
});

test('third review: the daily count of digest sets survives a restart, and revokes do not lock out the others', async () => {
  const [coordinator, member, other, revoked] = await Promise.all([1, 2, 3, 4].map(async () => deviceIdentity(await createDeviceCertificate())));
  const store = createCoordinatorStore();
  let counts = null;
  const repositoryChanges = { read: () => counts, write: (value) => { counts = value; } };
  const start = () => createCoordinatorService({ store, identity: coordinator, name: 'Coordinator', repositoryChanges,
    authority: { keyId: '0'.repeat(32), publicKey: Buffer.alloc(32).toString('base64url') } });
  for (const entry of [member, other, revoked]) store.upsertNode({ id: entry.fingerprint, name: 'Device', certPem: entry.certPem, at: new Date().toISOString() });
  const digest = (index) => index.toString(16).padStart(32, '0');
  let service = start();
  let key = service.publishDirectory(other.fingerprint, { agents: [] }).repositoryKey;
  service.publishDirectory(other.fingerprint, { agents: [], repositories: { keyId: key.id, digests: [digest(7)] } });
  const memberSets = (count, from) => {
    for (let index = 0; index < count; index += 1) {
      service.publishDirectory(member.fingerprint, { agents: [], repositories: { keyId: key.id, digests: [digest(from + index)] } });
    }
  };
  memberSets(4, 100);
  service = start();
  key = service.publishDirectory(other.fingerprint, { agents: [] }).repositoryKey;
  service.publishDirectory(other.fingerprint, { agents: [], repositories: { keyId: key.id, digests: [digest(7)] } });
  memberSets(1, 200);
  service.publishDirectory(member.fingerprint, { agents: [], repositories: { keyId: key.id, digests: [digest(7)] } });
  assert.deepEqual(service.directory(member.fingerprint).devices.find((entry) => entry.nodeId === other.fingerprint).sameRepositories, [],
    'the restart did not give the member three new guesses');
  for (let index = 0; index < 3; index += 1) {
    store.upsertNode({ id: revoked.fingerprint, name: 'Device', certPem: revoked.certPem, at: new Date().toISOString() });
    service.revoke(revoked.fingerprint);
  }
  key = service.publishDirectory(other.fingerprint, { agents: [] }).repositoryKey;
  service.publishDirectory(other.fingerprint, { agents: [], repositories: { keyId: key.id, digests: [digest(7)] } });
  service.publishDirectory(member.fingerprint, { agents: [], repositories: { keyId: key.id, digests: [digest(7)] } });
  assert.deepEqual(service.directory(member.fingerprint).devices.find((entry) => entry.nodeId === other.fingerprint).sameRepositories, [digest(7)],
    'after revokes, each device\'s first set under the new key is taken');
  store.close();
});

test('third review: nearby requests reaching this computer on a virtual adapter are answered as unknown paths', { timeout: 20_000 }, async () => {
  const bus = discoveryBus();
  const virtual = () => ({ 'vEthernet (WSL)': [{ address: '127.0.0.1', family: 'IPv4', internal: false }] });
  const desk = await device('desk', { discovery: bus.discovery, runtimeOptions: { interfaces: virtual } });
  try {
    await desk.runtime.nearbyOn({ name: 'Desk' });
    assert.equal(await strangerReroll(listenPort(desk.app), await createDeviceCertificate(), 1), 'device_not_trusted');
    assert.equal((await desk.runtime.status()).nearby.attempts.lastDay, 0, 'nothing was counted');
  } finally { await desk.close(); }
});

test('third review: paired shows only once the other computer used the trust; until then it says waiting', { timeout: 30_000 }, async () => {
  const bus = discoveryBus();
  const [desk, laptop] = await Promise.all([device('desk', { discovery: bus.discovery }),
    device('laptop', { discovery: bus.discovery, runtimeOptions: { trustUseMs: 60_000, pairedGraceMs: 60_000 } })]);
  try {
    await desk.runtime.nearbyOn({ name: 'Desk' });
    await laptop.runtime.nearbyOn({ name: 'Laptop' });
    const { here, there } = await nearbyPair(desk, laptop);
    const nodeStore = desk.app.peer.nodeStore();
    const setSetting = nodeStore.setSetting.bind(nodeStore);
    nodeStore.setSetting = (key, value) => {
      if (key === 'membership' && value?.role === 'member') throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' });
      return setSetting(key, value);
    };
    await desk.runtime.confirmPairing({ requestId: here.requestId, code: there.code });
    await laptop.runtime.confirmPairing({ requestId: there.requestId, code: here.code });
    const waiting = await until(laptop.runtime, (status) => status.devices.some((entry) => !entry.self && entry.status === 'active'), 'the laptop to trust the desk');
    assert.equal((await laptop.runtime.status()).nearby.pairing.state, 'waiting', 'the desk never connected, so not paired');
    assert.ok(waiting);
  } finally { await desk.close(); await laptop.close(); }
});

// A device that never paired asks for a nonce over real TLS and cancels: the second review's re-roll.
async function strangerReroll(port, certificate, index) {
  const nonce = createHash('sha256').update(`x${index}`).digest('base64url');
  const post = (path, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const sent = httpsRequest({ host: '127.0.0.1', port, path, method: 'POST', key: certificate.keyPem, cert: certificate.certPem,
      rejectUnauthorized: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
    });
    sent.on('error', reject);
    sent.end(payload);
  });
  const answer = await post('/peer/1/nearby/request', { protocol: 1, commit: createHash('sha256').update(`fuli-pair-commit:1:${nonce}`).digest('hex'),
    name: 'Stranger', authority: { keyId: 'a'.repeat(32), publicKey: Buffer.alloc(32, 7).toString('base64url') }, coordinates: false });
  if (answer.status !== 200) return answer.body.error;
  await post('/peer/1/nearby/poll', { requestId: answer.body.requestId, cancel: true });
  return 'granted';
}

const listenPort = (app) => Number(new URL(app.peer.nodeStore().setting('membership').coordinator.url).port);
const restartedRuntime = (record, options = {}) => createPeerRuntime({ host: createFuliRoundtableHost(record.app), roundtable: record.app.roundtable,
  port: record.app.peer, allowLoopback: true, claimWaitMs: 300, interfaces: () => ({}), nearbyListenHost: '127.0.0.1',
  createDiscovery: discoveryBus().discovery, ...options });

test('second review: pairing attempts survive nearby off and on and a restart, on-while-on keeps its end, and only the person clears them', { timeout: 30_000 }, async () => {
  const bus = discoveryBus();
  const desk = await device('desk', { discovery: bus.discovery });
  let restarted = null;
  try {
    await desk.runtime.nearbyOn({ name: 'Desk' });
    const certificates = await Promise.all(Array.from({ length: 6 }, () => createDeviceCertificate()));
    const first = [];
    for (const [index, certificate] of certificates.entries()) first.push(await strangerReroll(listenPort(desk.app), certificate, index));
    assert.deepEqual(first, ['granted', 'granted', 'granted', 'granted', 'granted', 'pairing_rate_limited']);
    const until1 = desk.app.peer.nodeStore().setting('nearby').until;
    await delay(20);
    await desk.runtime.nearbyOn({});
    assert.equal(desk.app.peer.nodeStore().setting('nearby').until, until1, 'on while on never extends the end');
    await desk.runtime.nearbyOff();
    const again = await desk.runtime.nearbyOn({ name: 'Desk' });
    assert.deepEqual([again.nearby.limited, again.nearby.canPair], [true, false]);
    assert.equal(await strangerReroll(listenPort(desk.app), certificates[0], 50), 'pairing_rate_limited');
    await desk.runtime.close();
    restarted = restartedRuntime(desk);
    await restarted.resume();
    assert.equal((await restarted.status()).nearby.attempts.lastWindow, 5, 'a restart forgets nothing');
    const cleared = await restarted.clearPairingAttempts();
    assert.deepEqual([cleared.nearby.limited, cleared.nearby.attempts.lastDay], [false, 0]);
  } finally { await restarted?.close(); await desk.close(); }
});

test('second review: a coordinator whose address is gone says so, and turning it off revokes its devices even without a listener', { timeout: 30_000 }, async () => {
  const [laptop, desk] = await Promise.all([device('laptop'), device('desk')]);
  let restarted = null;
  try {
    await pair(laptop, desk, { folder: false });
    const store = laptop.app.peer.nodeStore();
    const deskNode = (await laptop.runtime.status()).devices.find((entry) => !entry.self).nodeId;
    await laptop.runtime.close();
    store.setSetting('coordinator', { ...store.setting('coordinator'), host: '10.255.255.1' });
    restarted = restartedRuntime(laptop);
    await restarted.resume();
    const stuck = await restarted.status();
    assert.deepEqual([stuck.role, stuck.coordinator.listening, stuck.coordinator.listenFailure.address], ['coordinator', false, '10.255.255.1']);
    assert.equal(stuck.devices.find((entry) => entry.nodeId === deskNode).status, 'active', 'trust is kept, but nothing listens');
    await restarted.disable();
    const on = await restarted.nearbyOn({ name: 'Laptop' });
    assert.equal(on.devices.some((entry) => entry.nodeId === deskNode && entry.status === 'active'), false, 'old devices are not trusted again');
  } finally { await restarted?.close(); await desk.close(); await laptop.close(); }
});

test('second review: trust waiting for its first use is still taken back after a restart', { timeout: 30_000 }, async () => {
  const bus = discoveryBus();
  const [desk, laptop] = await Promise.all([device('desk', { discovery: bus.discovery }),
    device('laptop', { discovery: bus.discovery, runtimeOptions: { trustUseMs: 2_000, pairedGraceMs: 60_000 } })]);
  let restarted = null;
  try {
    await desk.runtime.nearbyOn({ name: 'Desk' });
    await laptop.runtime.nearbyOn({ name: 'Laptop' });
    const { here, there } = await nearbyPair(desk, laptop);
    const nodeStore = desk.app.peer.nodeStore();
    const setSetting = nodeStore.setSetting.bind(nodeStore);
    nodeStore.setSetting = (key, value) => {
      if (key === 'membership' && value?.role === 'member') throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' });
      return setSetting(key, value);
    };
    await desk.runtime.confirmPairing({ requestId: here.requestId, code: there.code });
    await laptop.runtime.confirmPairing({ requestId: there.requestId, code: here.code });
    await until(laptop.runtime, (status) => status.devices.some((entry) => !entry.self && entry.status === 'active'), 'the laptop to trust the desk');
    await laptop.runtime.close();
    // Closed well inside the deadline even on a slow runner; restarted after it.
    await delay(2_100);
    restarted = restartedRuntime(laptop);
    await restarted.resume();
    const after = await restarted.status();
    assert.deepEqual([after.devices.filter((entry) => !entry.self).map((entry) => entry.status), after.nearby.ended?.kind], [['revoked'], 'trust_withdrawn']);
  } finally { await restarted?.close(); await desk.close(); await laptop.close(); }
});

// The listener the runtime asks for, recorded, and opened on loopback whatever
// the address: which loopback aliases an operating system has (macOS has only
// 127.0.0.1) and its firewall never decide what these tests prove.
function recordedListener({ refuse = null } = {}) {
  const asked = [];
  return { asked, startServer: (options) => {
    asked.push(options.host);
    if (options.host === refuse) return Promise.reject(Object.assign(new Error('synthetic'), { code: 'EADDRNOTAVAIL' }));
    return startCoordinatorServer({ ...options, host: '127.0.0.1' });
  } };
}

test('second review: a listener the person placed returns there when nearby turns off, and where devices reached it is kept', { timeout: 30_000 }, async () => {
  const listener = recordedListener();
  const [laptop, desk] = await Promise.all([device('laptop', { discovery: discoveryBus().discovery,
    runtimeOptions: { nearbyListenHost: '0.0.0.0', startServer: listener.startServer } }), device('desk')]);
  try {
    await pair(laptop, desk, { folder: false });
    const store = laptop.app.peer.nodeStore();
    await until(laptop.runtime, (status) => status.devices.some((entry) => !entry.self && entry.online), 'the desk to connect');
    assert.deepEqual(Object.values(store.setting('reachedAddresses')), ['127.0.0.1', '127.0.0.1']);
    await laptop.runtime.nearbyOn({ name: 'Laptop' });
    assert.deepEqual([store.setting('coordinator').host, store.setting('nearby').previousHost], ['0.0.0.0', '127.0.0.1']);
    await laptop.runtime.nearbyOff();
    assert.equal(store.setting('coordinator').host, '127.0.0.1');
    assert.deepEqual(listener.asked, ['127.0.0.1', '0.0.0.0', '127.0.0.1'], 'the listener really moved and came back');
    await until(laptop.runtime, (status) => status.devices.some((entry) => !entry.self && entry.online), 'the desk to reconnect');
  } finally { await desk.close(); await laptop.close(); }
});

test('an address nearby pairing cannot listen on leaves the listener where the person placed it, trusting the same devices', { timeout: 30_000 }, async () => {
  const listener = recordedListener({ refuse: '0.0.0.0' });
  const [laptop, desk] = await Promise.all([device('laptop', { discovery: discoveryBus().discovery,
    runtimeOptions: { nearbyListenHost: '0.0.0.0', startServer: listener.startServer } }), device('desk')]);
  try {
    await pair(laptop, desk, { folder: false });
    const before = (await laptop.runtime.status()).devices.filter((entry) => !entry.self).map((entry) => [entry.nodeId, entry.status]);
    const on = await laptop.runtime.nearbyOn({ name: 'Laptop' });
    assert.deepEqual([laptop.app.peer.nodeStore().setting('coordinator').host, on.coordinator.listening], ['127.0.0.1', true]);
    assert.deepEqual(listener.asked, ['127.0.0.1', '0.0.0.0', '127.0.0.1']);
    assert.deepEqual(on.devices.filter((entry) => !entry.self).map((entry) => [entry.nodeId, entry.status]), before);
  } finally { await desk.close(); await laptop.close(); }
});

test('security review: a taken mDNS port turns nearby pairing off with its reason and the console keeps running', { timeout: 20_000 }, async () => {
  const bus = discoveryBus();
  const desk = await device('desk', { discovery: bus.discovery });
  try {
    await desk.runtime.nearbyOn({ name: 'Desk' });
    bus.fail(Object.assign(new Error('bind EADDRINUSE 0.0.0.0:5353'), { code: 'EADDRINUSE' }));
    const off = await until(desk.runtime, (status) => !status.nearby.on && !status.role, 'nearby and its listener to close');
    assert.deepEqual([off.nearby.ended.kind, off.nearby.ended.reason, off.role], ['discovery_failed', 'EADDRINUSE', null]);
    assert.deepEqual([bus.adverts.size, bus.browsers.size], [0, 0]);
    await desk.runtime.resume();
    assert.equal((await desk.runtime.status()).nearby.on, false, 'nothing turns it on again by itself');
  } finally { await desk.close(); }

  // The failure can arrive while turning on is still under way: nothing is closed twice.
  const errors = [];
  const racing = discoveryBus();
  const tablet = await device('tablet', { discovery: (hooks) => {
    const discovery = racing.discovery(hooks);
    return { ...discovery, browse: (handlers) => {
      setImmediate(() => hooks.onFailure(Object.assign(new Error('bind'), { code: 'EADDRINUSE' })));
      return discovery.browse(handlers);
    } };
  }, runtimeOptions: { onError: (error) => errors.push(error) } });
  try {
    await tablet.runtime.nearbyOn({ name: 'Tablet' });
    await until(tablet.runtime, (status) => !status.nearby.on && !status.role, 'nearby to stop');
    assert.deepEqual(errors.filter((error) => error instanceof TypeError), []);
  } finally { await tablet.close(); }
});

test('nearby pairing turns itself off after a pairing and after its time, with a default name that is never the hostname', { timeout: 30_000 }, async () => {
  const bus = discoveryBus();
  const quick = { pairedGraceMs: 100 };
  const [desk, laptop] = await Promise.all([device('desk', { discovery: bus.discovery, runtimeOptions: quick }),
    device('laptop', { discovery: bus.discovery, runtimeOptions: { ...quick, nearbySessionMs: 60_000 } })]);
  try {
    const on = await desk.runtime.nearbyOn({});
    assert.match(on.nearby.name, /^FULI [0-9A-F]{4}$/);
    assert.equal(on.nearby.name, `FULI ${on.device.shortFingerprint.slice(15, 19)}`);
    await laptop.runtime.nearbyOn({ name: 'Laptop' });
    const { here, there } = await nearbyPair(desk, laptop);
    await desk.runtime.confirmPairing({ requestId: here.requestId, code: there.code });
    await laptop.runtime.confirmPairing({ requestId: there.requestId, code: here.code });
    for (const runtime of [desk.runtime, laptop.runtime]) {
      const ended = await until(runtime, (status) => !status.nearby.on, 'nearby to turn itself off');
      assert.deepEqual([ended.nearby.ended.kind, ended.nearby.devices], ['paired', []]);
    }
    assert.deepEqual([bus.adverts.size, bus.browsers.size], [0, 0]);
  } finally { await desk.close(); await laptop.close(); }

  const tablet = await device('tablet', { discovery: bus.discovery, runtimeOptions: { nearbySessionMs: 100 } });
  try {
    await tablet.runtime.nearbyOn({ name: 'Tablet' });
    const ended = await until(tablet.runtime, (status) => !status.nearby.on && !status.role, 'the session and its listener to end');
    assert.deepEqual([ended.nearby.ended.kind, ended.role], ['timeout', null], 'the listener it opened closes too');
  } finally { await tablet.close(); }
});

test('trust written for a pairing the other computer never finished is taken back', { timeout: 30_000 }, async () => {
  const bus = discoveryBus();
  const [desk, laptop] = await Promise.all([device('desk', { discovery: bus.discovery }),
    device('laptop', { discovery: bus.discovery, runtimeOptions: { trustUseMs: 1_500, pairedGraceMs: 60_000 } })]);
  try {
    await desk.runtime.nearbyOn({ name: 'Desk' });
    await laptop.runtime.nearbyOn({ name: 'Laptop' });
    const { here, there } = await nearbyPair(desk, laptop);
    // The desk cannot record its membership: its side of the pairing fails after the laptop trusted it.
    const nodeStore = desk.app.peer.nodeStore();
    const setSetting = nodeStore.setSetting.bind(nodeStore);
    nodeStore.setSetting = (key, value) => {
      if (key === 'membership' && value?.role === 'member') throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' });
      return setSetting(key, value);
    };
    await desk.runtime.confirmPairing({ requestId: here.requestId, code: there.code });
    await laptop.runtime.confirmPairing({ requestId: there.requestId, code: here.code });
    await until(laptop.runtime, (status) => status.devices.some((entry) => !entry.self && entry.status === 'active'), 'the laptop to trust the desk');
    await until(laptop.runtime, (status) => status.nearby.ended?.kind === 'trust_withdrawn', 'the trust to be taken back');
    const withdrawn = await laptop.runtime.status();
    assert.deepEqual(withdrawn.devices.filter((entry) => !entry.self).map((entry) => entry.status), ['revoked']);
    assert.equal(withdrawn.nearby.ended.name, 'Desk');
  } finally { await desk.close(); await laptop.close(); }
});

test('a share list the coordinator never gets fails loudly, and an unreadable team keeps the published lead', { timeout: 30_000 }, async () => {
  const [desk, laptop] = await Promise.all([device('desk'), device('laptop')]);
  try {
    await pair(laptop, desk);
    const shared = await until(laptop.runtime, (status) => status.devices.find((entry) => !entry.self)?.sharedAgents === 1, 'the share to arrive');
    assert.equal(shared.devices.find((entry) => !entry.self).sharedAgents, 1);

    // A team read that fails for a moment is not a handoff: the lead stays shared.
    const policy = desk.app.personal.getProjectAgentCoordinationPolicy;
    desk.app.personal.getProjectAgentCoordinationPolicy = async () => { throw Object.assign(new Error('busy'), { code: 'graph_busy' }); };
    await desk.runtime.publish();
    assert.equal((await laptop.runtime.status()).devices.find((entry) => !entry.self).sharedAgents, 1);
    assert.equal((await desk.runtime.status()).shares[0].state, 'team_unreadable');
    desk.app.personal.getProjectAgentCoordinationPolicy = policy;

    await laptop.runtime.close();
    await assert.rejects(desk.runtime.setShares({ shares: [{ projectId: desk.projectId, clients: ['codex'] }] }),
      (error) => error.code === 'share_not_published' && /coordinator/.test(error.message));
    assert.ok((await desk.runtime.status()).lastPublish.error, 'status keeps why the list was not delivered');
  } finally { await desk.close(); await laptop.close(); }
});
