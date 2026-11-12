import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

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
    // Nothing private is advertised: a fingerprint-derived name and host, the chosen name, port and version.
    assert.deepEqual(Object.keys(record.txt).sort(), ['fp', 'n', 'v']);
    assert.match(record.name, /^FULI [0-9a-f]{16}$/);
    assert.match(record.host, /^fuli-[0-9a-f]{16}\.local$/);

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

test('paired computers see the projects they share by their own repository', { timeout: 30_000 }, async () => {
  const repository = 'git@example.test:team/shared-app.git';
  const [desk, laptop] = await Promise.all([device('desk', { repository }), device('laptop', { repository: 'https://example.test/team/shared-app' })]);
  try {
    await pair(laptop, desk, { folder: false });
    const status = await until(desk.runtime, (entry) => entry.shareable[0]?.sameProjectOn.length > 0, 'the same project to show');
    assert.deepEqual(status.shareable[0].sameProjectOn.map((entry) => entry.name), ['Coordinator']);
    assert.equal(status.shareable[0].knownFolder, null, 'no session here says where the project lives');
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
