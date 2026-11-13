import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { runPeerControlCommand } from '../packages/roundtable/src/peer/control-cli.js';
import { startCoordinatorServer } from '../packages/roundtable/src/peer/coordinator-http.js';
import { createPeerRuntime } from '../packages/roundtable/src/peer/peer-runtime.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { device, discoveryBus } from './fixtures/peer-devices.js';

// Synthetic repositories only.
const COMMON = 'git@example.test:team/common-app.git';
const repo = (name) => `git@example.test:team/${name}.git`;

// A personal project as the Provider lists it.
function project(id, name, { own = null, reference = null, archived = false, temporary = false, session = false } = {}) {
  return { project_id: id, name, ...(temporary ? { scope_type: 'temporary' } : {}),
    profile: { name, ...(archived ? { lifecycle: 'archived' } : {}), ...(session ? { origin: 'conversation_fallback' } : {}),
      sources: [...(own ? [{ kind: 'repository', role: 'own', uri: own }] : []),
        ...(reference ? [{ kind: 'repository', role: 'reference', uri: reference }] : [])] } };
}

// Gives a fixture device these projects, its lead assigned to each, and counts team reads.
function withProjects(record, projects) {
  const leadId = record.projectId.replace(/-project$/, '-lead');
  const lead = (record.lead = { agentId: leadId });
  record.app.personal.listPersonalProjects = async () => projects;
  record.app.personal.listProjectAgents = async () => [{ agent_id: leadId, profile: { status: 'active', name: `${leadId} name` },
    assignments: projects.map((entry) => ({ personal_project_id: entry.project_id, status: 'active' })) }];
  record.teamReads = [];
  const policy = record.app.personal.getProjectAgentCoordinationPolicy;
  record.app.personal.getProjectAgentCoordinationPolicy = async (space, projectId) => {
    record.teamReads.push(projectId);
    return policy(space, projectId);
  };
  return lead;
}

async function until(runtime, matches, label) {
  for (let index = 0; index < 200; index += 1) {
    const status = await runtime.status();
    if (matches(status)) return status;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const fillers = (prefix, count) => Array.from({ length: count }, (_, index) =>
  project(`${prefix}-filler-${index}`, `Synthetic filler ${String(index).padStart(3, '0')}`));

// A folder that is a Git checkout whose origin is the given address.
async function checkout(origin) {
  const folder = await mkdtemp(join(tmpdir(), 'fuli-peer-checkout-'));
  await mkdir(join(folder, '.git'));
  await writeFile(join(folder, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`);
  return folder;
}

test('status lists only shared and same-repository projects, the search finds the rest, and a joined invitation shares only the common project', { timeout: 30_000 }, async () => {
  // The desk knows a checkout of the common repository, but its own project resolution does not map it there.
  const unmapped = await checkout(COMMON);
  const [laptop, desk] = await Promise.all([device('laptop'), device('desk', { sessionFolder: unmapped })]);
  try {
    withProjects(laptop, [project('laptop-common', 'Common app', { own: COMMON }),
      project('laptop-r2', 'Laptop r2', { own: repo('r2') }), project('laptop-r3', 'Laptop r3', { own: repo('r3') }),
      project('laptop-r4', 'Laptop r4', { own: repo('r4') }), project('laptop-r5', 'Laptop r5', { own: repo('r5') }),
      project('laptop-hidden-archived', 'Hidden archived', { archived: true }),
      project('laptop-hidden-temporary', 'Hidden temporary', { temporary: true }),
      project('laptop-hidden-session', 'Hidden session', { session: true }),
      ...fillers('laptop', 300)]);
    withProjects(desk, [project('desk-common', 'Desk common', { own: COMMON }),
      project('desk-reference', 'Desk reference', { reference: repo('r2') }),
      project('desk-archived', 'Desk archived', { own: repo('r3'), archived: true }),
      project('desk-temporary', 'Desk temporary', { own: repo('r4'), temporary: true }),
      project('desk-session', 'Desk session', { own: repo('r5'), session: true }),
      project('desk-unrelated', 'Desk unrelated', { own: repo('desk-only') })]);
    desk.app.personal.recentAgentSessions = async () => [{ source_application: 'codex', session_id: 'desk-recent',
      personal_project_id: 'desk-common', last_active: '2030-01-01T08:00:00.000Z' }];

    await laptop.runtime.enableCoordinator({ host: '127.0.0.1', port: 0, name: 'Laptop' });
    const joined = await desk.runtime.join({ invitation: laptop.runtime.createInvitation().invitation, name: 'Desk' });
    // Joining with the invitation shares exactly the project both computers have, lead only, first allowed client.
    // The folder gets the check a manual save makes, so a checkout the host does not map to the project is not stored.
    assert.deepEqual(joined.shares.map((share) => [share.projectId, share.clients, share.workingDirectory]), [['desk-common', ['codex'], null]]);
    assert.deepEqual(joined.autoShared.map((record) => record.projects), [[{ projectId: 'desk-common', projectName: 'Desk common' }]]);
    assert.equal(joined.groupSize, 2);
    assert.equal(joined.shareable[0].knownFolder, unmapped, 'the folder is known, only not confirmed for this project');

    // The coordinator took no confirming action: the same project is a suggestion, not a share.
    // The desk's archived and session-only projects publish no digest, so Laptop r3 and r5 are no suggestions.
    const suggested = await until(laptop.runtime, (status) => status.shareable.length > 0, 'the suggestion to show');
    assert.deepEqual([suggested.shares, suggested.autoShared], [[], []]);
    assert.deepEqual(suggested.shareable.map((entry) => [entry.projectId, entry.sameProjectOn.map((device) => device.name)]),
      [['laptop-common', ['Desk']]]);
    assert.equal(suggested.shareable[0].lead.agentId, laptop.lead.agentId);

    laptop.teamReads.length = 0;
    await laptop.runtime.status();
    assert.deepEqual(laptop.teamReads, ['laptop-common'], 'one team read for the one listed project, not one per project');

    laptop.teamReads.length = 0;
    const narrowed = await laptop.runtime.searchShareable({ query: 'FILLER 01', limit: 5 });
    assert.deepEqual(narrowed.projects.map((entry) => entry.projectName),
      ['Synthetic filler 010', 'Synthetic filler 011', 'Synthetic filler 012', 'Synthetic filler 013', 'Synthetic filler 014']);
    assert.equal(narrowed.more, true);
    const recent = await laptop.runtime.searchShareable({});
    assert.equal(recent.projects.length, 20);
    assert.deepEqual(recent.projects.slice(0, 2).map((entry) => entry.projectId), ['laptop-r2', 'laptop-r3'], 'the host order, listed ones left out');
    assert.equal(recent.more, true);
    assert.deepEqual(await laptop.runtime.searchShareable({ query: 'hidden' }), { projects: [], more: false });
    assert.deepEqual(await laptop.runtime.searchShareable({ query: 'common' }), { projects: [], more: false }, 'the short list already shows it');
    const exact = await laptop.runtime.searchShareable({ query: 'filler 299' });
    assert.deepEqual(exact, { projects: [{ projectId: 'laptop-filler-299', projectName: 'Synthetic filler 299' }], more: false });
    assert.deepEqual(laptop.teamReads, [], 'searching reads no team');

    const picked = await laptop.runtime.shareableProject('laptop-filler-7');
    assert.deepEqual([picked.projectName, picked.lead.agentId, picked.clients, picked.sameProjectOn, picked.knownFolder],
      ['Synthetic filler 007', laptop.lead.agentId, ['codex'], [], null]);
    for (const hidden of ['laptop-hidden-archived', 'laptop-hidden-temporary', 'laptop-hidden-session', 'nobody']) {
      await assert.rejects(laptop.runtime.shareableProject(hidden), { code: 'project_not_found' });
    }

    // Sharing the suggestion is the person's one click there; a removed share leaves the short list unless suggested.
    await laptop.runtime.setShares({ shares: [{ projectId: 'laptop-common', clients: ['codex'] }, { projectId: 'laptop-filler-7', clients: ['codex'] }] });
    assert.deepEqual((await laptop.runtime.status()).shareable.map((entry) => entry.projectId), ['laptop-common', 'laptop-filler-7']);
    const removed = await laptop.runtime.setShares({ shares: [{ projectId: 'laptop-common', clients: ['codex'] }] });
    assert.deepEqual(removed.shareable.map((entry) => entry.projectId), ['laptop-common']);

    const lines = [];
    await runPeerControlCommand(['status'], { baseUrl: () => 'http://127.0.0.1:1', command: 'fuli', notRunning: 'not running',
      write: (line) => lines.push(line), fetchImpl: async () => new Response(JSON.stringify(await desk.runtime.status())) });
    assert.ok(lines.includes('Shared after pairing (projects the other computer has too): Desk common'), lines.join('\n'));

    // Revoking the device forgets its record, as turning the roundtable off does.
    const deskNode = (await laptop.runtime.status()).devices.find((entry) => !entry.self).nodeId;
    laptop.app.peer.nodeStore().setSetting('autoShared', { [deskNode]: { state: 'done', since: 1, at: '2030-01-01T00:00:00.000Z', projects: [] } });
    await laptop.runtime.revokeDevice(deskNode);
    assert.equal(laptop.app.peer.nodeStore().setting('autoShared'), null);
  } finally { await desk.close(); await laptop.close(); await rm(unmapped, { recursive: true, force: true }); }
});

test('joining a group that has another computer shares nothing automatically and says the group is larger', { timeout: 30_000 }, async () => {
  const [laptop, tablet, desk] = await Promise.all([device('laptop'), device('tablet'), device('desk')]);
  try {
    withProjects(laptop, [project('laptop-common', 'Common app', { own: COMMON })]);
    withProjects(desk, [project('desk-common', 'Desk common', { own: COMMON })]);
    await laptop.runtime.enableCoordinator({ host: '127.0.0.1', port: 0, name: 'Laptop' });
    await tablet.runtime.join({ invitation: laptop.runtime.createInvitation().invitation, name: 'Tablet' });
    const joined = await desk.runtime.join({ invitation: laptop.runtime.createInvitation().invitation, name: 'Desk' });
    assert.deepEqual(joined.shares, []);
    assert.deepEqual(joined.autoShared.map((record) => [record.projects, record.skipped, record.matched]), [[[], 'group', 1]]);
    assert.equal(joined.groupSize, 3);
    assert.deepEqual(joined.shareable.map((entry) => entry.projectId), ['desk-common'], 'left for the one-click button');
  } finally { await desk.close(); await tablet.close(); await laptop.close(); }
});

test('fuli peer join says what joining shares before it joins', async () => {
  const lines = [];
  const paths = [];
  await runPeerControlCommand(['join', '--invitation', 'fuli-peer-invite:1:synthetic'], { baseUrl: () => 'http://127.0.0.1:1', command: 'fuli',
    notRunning: 'not running', write: (line) => lines.push(line),
    fetchImpl: async (url) => { paths.push([lines.length, new URL(url).pathname]); return new Response(JSON.stringify({ role: null, addresses: [] })); } });
  assert.equal(lines[0], 'Once confirmed, leads of up to 8 projects the other computer says it has too can talk. Nothing else.');
  assert.deepEqual(paths, [[1, '/api/peer/join']], 'the sentence comes before the join request');
});

test('a confirmed nearby pairing shares only the common project on both computers, once, and an untick stays', { timeout: 40_000 }, async () => {
  const bus = discoveryBus();
  // The coordinator's first read comes before the other computer published its digests: the one retry finds them.
  const quick = { autoShareRetryMs: 1_500, pairedGraceMs: 100 };
  const [desk, laptop] = await Promise.all([device('desk', { discovery: bus.discovery, runtimeOptions: quick }),
    device('laptop', { discovery: bus.discovery, runtimeOptions: quick })]);
  let restarted = null;
  try {
    withProjects(desk, [project('desk-common', 'Desk common', { own: COMMON }), project('desk-unrelated', 'Desk unrelated', { own: repo('desk-only') }),
      project('desk-reference', 'Desk reference', { reference: repo('r2') })]);
    withProjects(laptop, [project('laptop-common', 'Laptop common', { own: COMMON }), project('laptop-unrelated', 'Laptop unrelated', { own: repo('laptop-only') }),
      project('laptop-r2', 'Laptop r2', { own: repo('r2') })]);
    await desk.runtime.nearbyOn({ name: 'Desk' });
    await laptop.runtime.nearbyOn({ name: 'Laptop' });
    const seen = await until(desk.runtime, (status) => status.nearby.devices.length > 0, 'the laptop to be listed');
    await desk.runtime.pairNearby({ fingerprint: seen.nearby.devices[0].fingerprint.slice(0, 6) });
    const [here, there] = await Promise.all([until(desk.runtime, (status) => status.nearby.pairing?.state === 'confirm', 'desk code'),
      until(laptop.runtime, (status) => status.nearby.pairing?.state === 'confirm', 'laptop code')]);
    await desk.runtime.confirmPairing({ requestId: here.nearby.pairing.requestId, code: there.nearby.pairing.code });
    await laptop.runtime.confirmPairing({ requestId: there.nearby.pairing.requestId, code: here.nearby.pairing.code });

    for (const [record, expected] of [[desk, 'desk-common'], [laptop, 'laptop-common']]) {
      // One status reads shares before the record, so it waits until it shows both.
      const done = await until(record.runtime, (status) => status.autoShared.length === 1 && status.shares.length > 0, `${expected} to be shared`);
      assert.deepEqual(done.shares.map((share) => [share.projectId, share.agentId, share.clients]), [[expected, record.lead.agentId, ['codex']]]);
      assert.deepEqual(done.autoShared[0].projects.map((entry) => entry.projectId), [expected]);
    }
    // Each computer can now ask the other's common lead, and only that one.
    for (const [record, otherProject] of [[desk, 'Laptop common'], [laptop, 'Desk common']]) {
      let remote = [];
      for (let index = 0; index < 100 && !remote.length; index += 1) {
        remote = (await record.app.roundtable.findAgents({})).remoteAgents ?? [];
        if (!remote.length) await delay(50);
      }
      assert.deepEqual(remote.map((agent) => agent.projectName), [otherProject], JSON.stringify(remote));
    }

    // The person unticks it: no status read, retry or restart shares it again.
    const fingerprint = Object.keys(desk.app.peer.nodeStore().setting('autoShared'))[0];
    await desk.runtime.setShares({ shares: [] });
    await delay(400);
    await desk.runtime.status();
    await desk.runtime.close();
    restarted = createPeerRuntime({ host: createFuliRoundtableHost(desk.app), roundtable: desk.app.roundtable, port: desk.app.peer,
      allowLoopback: true, claimWaitMs: 300, interfaces: () => ({}), nearbyListenHost: '127.0.0.1', createDiscovery: discoveryBus().discovery, ...quick });
    await restarted.resume();
    await delay(400);
    const after = await restarted.status();
    assert.deepEqual(after.shares, []);
    assert.deepEqual(after.shareable.map((entry) => entry.projectId), ['desk-common'], 'still suggested, for the person to tick again');
    assert.deepEqual(Object.keys(desk.app.peer.nodeStore().setting('autoShared')), [fingerprint], 'recorded once for this pairing');
  } finally { await restarted?.close(); await desk.close(); await laptop.close(); }
});

// One physical adapter; its address is loopback so the moved listener stays reachable in a test.
const LAN = { eth0: [{ address: '127.0.0.1', family: 'IPv4', internal: false }] };

// The listener the runtime asks for, recorded, and opened on loopback whatever the address.
function recordedListener() {
  const asked = [];
  return { asked, startServer: (options) => { asked.push(options.host); return startCoordinatorServer({ ...options, host: '127.0.0.1' }); } };
}

test('both computers share after a nearby pairing whose coordinator then moves its listener to a new repository key', { timeout: 60_000 }, async () => {
  const bus = discoveryBus();
  const listener = recordedListener();
  // A listener on every address, as in production: after pairing it narrows to the
  // address the other computer used, which starts a new coordinator with a new key.
  const options = { nearbyListenHost: '0.0.0.0', startServer: listener.startServer, pairedGraceMs: 100, interfaces: () => LAN,
    publishMs: 400, autoShareRetryMs: 150, autoShareAttempts: 60 };
  const [desk, laptop] = await Promise.all([device('desk', { discovery: bus.discovery, runtimeOptions: options }),
    device('laptop', { discovery: bus.discovery, runtimeOptions: options })]);
  try {
    withProjects(desk, [project('desk-common', 'Desk common', { own: COMMON }), project('desk-unrelated', 'Desk unrelated', { own: repo('desk-only') })]);
    withProjects(laptop, [project('laptop-common', 'Laptop common', { own: COMMON }), project('laptop-unrelated', 'Laptop unrelated', { own: repo('laptop-only') })]);
    await desk.runtime.nearbyOn({ name: 'Desk' });
    await laptop.runtime.nearbyOn({ name: 'Laptop' });
    const seen = await until(desk.runtime, (status) => status.nearby.devices.length > 0, 'the laptop to be listed');
    await desk.runtime.pairNearby({ fingerprint: seen.nearby.devices[0].fingerprint.slice(0, 6) });
    const [here, there] = await Promise.all([until(desk.runtime, (status) => status.nearby.pairing?.state === 'confirm', 'desk code'),
      until(laptop.runtime, (status) => status.nearby.pairing?.state === 'confirm', 'laptop code')]);
    await desk.runtime.confirmPairing({ requestId: here.nearby.pairing.requestId, code: there.nearby.pairing.code });
    await laptop.runtime.confirmPairing({ requestId: there.nearby.pairing.requestId, code: here.nearby.pairing.code });

    await until(laptop.runtime, (status) => !status.nearby.on && laptop.app.peer.nodeStore().setting('coordinator')?.host === '127.0.0.1',
      'the coordinator to move its listener');
    for (const [record, expected] of [[desk, 'desk-common'], [laptop, 'laptop-common']]) {
      const done = await until(record.runtime, (status) => status.autoShared.length === 1 && status.shares.length > 0, `${expected} to be shared`);
      assert.deepEqual(done.shares.map((share) => share.projectId), [expected]);
      assert.deepEqual(done.autoShared[0].projects.map((entry) => entry.projectId), [expected]);
    }
    assert.ok(listener.asked.includes('0.0.0.0') && listener.asked.at(-1) === '127.0.0.1', JSON.stringify(listener.asked));
  } finally { await desk.close(); await laptop.close(); }
});
