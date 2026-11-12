import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCoordinatorService } from '../packages/roundtable/src/peer/coordinator-service.js';
import { createCoordinatorStore } from '../packages/roundtable/src/peer/coordinator-store.js';
import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
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

    await desk.runtime.confirmPairing({ requestId: here.requestId, code: there.code });
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
  service.revoke(laptop.fingerprint);
  assert.notEqual(service.publishDirectory(desk.fingerprint, { agents: [] }).repositoryKey.id, repositoryKey.id);
  store.close();
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
    device('laptop', { discovery: bus.discovery, runtimeOptions: { trustUseMs: 400, pairedGraceMs: 60_000 } })]);
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
