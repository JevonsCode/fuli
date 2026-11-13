import assert from 'node:assert/strict';
import test from 'node:test';

import { createPairingShare } from '../packages/roundtable/src/peer/pairing-share.js';

const project = (index) => ({ projectId: `p${index}`, name: `Project ${index}` });

// A pairing-share port over plain data: settings, shares, the person's saves and what the coordinator answers.
function harness({ answers, clock = { now: 1_000 }, prepareHook = null } = {}) {
  const settings = new Map();
  const state = { shares: [], touches: {}, paired: true, writes: [], afterWrites: 0, matches: 0 };
  const port = {
    setting: (key) => settings.get(key) ?? null,
    setSetting: (key, value) => (value === null ? settings.delete(key) : settings.set(key, value)),
    paired: () => state.paired,
    match: async () => answers[Math.min(state.matches++, answers.length - 1)],
    prepare: async (projects) => {
      await prepareHook?.();
      return projects.map((entry) => ({ projectName: entry.name, share: { projectId: entry.projectId, clients: ['codex'] } }));
    },
    sharedProjectIds: () => new Set(state.shares.map((share) => share.projectId)),
    touchedSince: (projectId, since) => (state.touches[projectId] ?? 0) >= since,
    writeShares: (shares) => { state.writes.push(shares.map((share) => share.projectId)); state.shares.push(...shares); },
    afterWrite: async () => { state.afterWrites += 1; },
  };
  const share = createPairingShare({ port, clock: () => clock.now, attemptMs: 5, attempts: 4 });
  return { share, state, settings, clock, record: (fingerprint) => settings.get('autoShared')?.[fingerprint] };
}

const settled = (common, others = 0) => ({ settled: true, others, common });
const unsettled = { settled: false, others: 0, common: [] };
const waitFor = async (check) => { for (let index = 0; index < 200 && !check(); index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };

test('pairing shares the common projects once the coordinator answered, and only once per device', async () => {
  const { share, state, record } = harness({ answers: [unsettled, unsettled, settled([project(1), project(2)])] });
  await share.start('device-a');
  assert.equal(record('device-a').state, 'pending', 'no answer yet writes no done record');
  await waitFor(() => record('device-a').state === 'done');
  assert.deepEqual(state.writes, [['p1', 'p2']]);
  assert.deepEqual(share.view()[0].projects.map((entry) => entry.projectId), ['p1', 'p2']);
  await share.start('device-a');
  assert.equal(state.writes.length, 1);
  share.close();
});

test('with no answer by the bound nothing is shared and the record says so', async () => {
  const clock = { now: 1_000 };
  const { share, state, record } = harness({ answers: [unsettled], clock });
  await share.start('device-a');
  clock.now += 100;
  await waitFor(() => record('device-a').state === 'done');
  assert.deepEqual([state.writes, share.view()[0].skipped], [[], 'unanswered']);
  share.close();
});

test('more than 8 common projects share none; the person decides with the one-click button', async () => {
  const nine = Array.from({ length: 9 }, (_, index) => project(index));
  const { share, state } = harness({ answers: [settled(nine)] });
  await share.start('device-a');
  assert.deepEqual(state.writes, []);
  assert.deepEqual([share.view()[0].skipped, share.view()[0].matched], ['too_many', 9]);
  const eight = harness({ answers: [settled(nine.slice(0, 8))] });
  await eight.share.start('device-a');
  assert.equal(eight.state.writes[0].length, 8);
});

test('a group with any other computer shares nothing automatically', async () => {
  const { share, state } = harness({ answers: [settled([project(1)], 1)] });
  await share.start('device-a');
  assert.deepEqual([state.writes, share.view()[0].skipped, share.view()[0].matched], [[], 'group', 1]);
});

test('a share the person saved or took back since the pairing, or made meanwhile, keeps their choice', async () => {
  let h;
  h = harness({ answers: [settled([project(1), project(2), project(3)])], prepareHook: async () => {
    h.state.shares.push({ projectId: 'p2', clients: ['claude_code'] });
    h.state.touches.p2 = h.clock.now;
    h.state.touches.p3 = h.clock.now;
  } });
  await h.share.start('device-a');
  assert.deepEqual(h.state.writes, [['p1']], 'p2 saved meanwhile is not overwritten, p3 unticked is not shared again');
  assert.deepEqual(h.state.shares.find((entry) => entry.projectId === 'p2').clients, ['claude_code']);
});

test('a device revoked or a roundtable turned off while waiting writes no record and shares nothing', async () => {
  const revoked = harness({ answers: [unsettled, settled([project(1)])] });
  await revoked.share.start('device-a');
  revoked.share.forget('device-a');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual([revoked.state.writes, revoked.record('device-a')], [[], undefined]);

  let off;
  off = harness({ answers: [settled([project(1)])], prepareHook: async () => { off.state.paired = false; } });
  await off.share.start('device-a');
  assert.deepEqual([off.state.writes, off.record('device-a').state], [[], 'pending']);
});

test('a pairing still waiting after a restart asks again', async () => {
  const first = harness({ answers: [unsettled] });
  await first.share.start('device-a');
  first.share.close();
  const settings = first.settings;
  const second = harness({ answers: [settled([project(4)])] });
  for (const [key, value] of settings) second.settings.set(key, value);
  second.share.resume();
  await waitFor(() => second.record('device-a')?.state === 'done');
  assert.deepEqual(second.state.writes, [['p4']]);
});
