import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { localProjectCreation, projectCreationDecision } from '../src/runner/project-creation.js';
import { RunnerHostStore } from '../src/runner/host-store.js';

const [host, laptop, spare] = ['a','b','c'].map(letter => letter.repeat(64));

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-owner-reservation-'));
  const stores = [];
  const open = () => {
    const store = new RunnerHostStore(join(dir, 'host.sqlite'), { spaceId: () => 'sample-space' });
    stores.push(store);
    return store.ownership();
  };
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { open, ledger: open() };
}

test('three connections seeking one project ID can install only one original owner', async t => {
  const { ledger, open } = setup(t);
  for (const device of [host, laptop, spare]) ledger.verified(device, []);
  const attempts = await Promise.all([host, laptop, spare].map((device, index) =>
    Promise.resolve().then(() => open().reserve(device, 'sample', 'request-' + index))));
  assert.deepEqual(attempts.map(a => a.ok), [true,false,false]);
  const restored = open();
  assert.deepEqual(restored.reserve(host, 'sample', 'request-0'), attempts[0]);
  const installed = restored.confirm(host, 'sample', 'request-0');
  assert.equal(installed.state, 'owned');
  assert.deepEqual(open().confirm(host, 'sample', 'request-0'), installed);
  assert.equal(open().confirm(spare, 'sample', 'request-0').ok, false);
});

test('unknown legacy devices block new IDs; an empty inventory never releases a prior claim', t => {
  const { ledger, open } = setup(t);
  ledger.expect(laptop);
  ledger.verified(host, ['existing']);
  assert.equal(ledger.reserve(host, 'new', 'create').code, 'inventory_incomplete');
  ledger.reported(laptop, ['elsewhere']);
  assert.equal(ledger.verified(laptop, []).code, 'inventory_incomplete');
  assert.equal(open().owner('elsewhere').state, 'reserved');
  assert.equal(ledger.verified(laptop, ['elsewhere']).ok, true);
  assert.equal(ledger.reserve(host, 'new', 'create').ok, true);
  ledger.verified(laptop, []);
  assert.equal(ledger.reserve(host, 'elsewhere', 'create').code, 'project_taken');
  ledger.reported(laptop, ['existing']);
  assert.equal(ledger.owner('existing').state, 'conflict');
  assert.equal(ledger.confirm(host, 'existing', 'inventory').ok, false);
  ledger.verified(host, ['existing']);
  assert.equal(ledger.owner('existing').state, 'conflict');
});

test('a move decision is single and durable across reopened SQLite connections', t => {
  const { ledger, open } = setup(t);
  ledger.verified(host, ['sample']);
  ledger.verified(laptop, []);
  const input = { project: 'sample', source: host, target: laptop, generation: 1, moveId: 'move-one' };
  assert.equal(ledger.move({ ...input, decision: 'committed' }).ok, false);
  assert.equal(ledger.move({ ...input, decision: 'preparing' }).ok, true);
  assert.equal(ledger.move({ ...input, moveId: 'other', decision: 'preparing' }).code, 'move_in_progress');
  assert.equal(ledger.move({ ...input, decision: 'committed' }).ok, true);
  assert.equal(open().move({ ...input, decision: 'committed' }).ok, true);
  assert.equal(open().move({ ...input, decision: 'aborted' }).ok, false);
  assert.equal(open().owner('sample').owner, laptop);
  assert.equal(open().owner('sample').generation, 2);
  const back = { project: 'sample', source: laptop, target: host, generation: 2, moveId: 'move-back' };
  assert.equal(ledger.move({ ...back, decision: 'preparing' }).ok, true);
  assert.equal(ledger.move({ ...back, decision: 'aborted' }).ok, true);
  assert.equal(ledger.owner('sample').owner, laptop);
});

test('a lost confirmation retries against the same authority and cannot lend its receipt to another space', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-reservation-receipt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spaceId = 'sample-space';
  const open = file => new RunnerHostStore(join(dir, file), { spaceId: () => spaceId });
  const registry = open('authority.sqlite');
  t.after(() => registry.close());
  registry.ownership().verified(host, []);
  registry.ownership().verified(laptop, []);
  let lose = true;
  let active = true;
  let receipt;
  const write = localProjectCreation(dir, spaceId, {
    descriptor: () => ({ device: laptop, authority: host }), identity: async () => ({ fingerprint: laptop }),
    openStore: () => open('local.sqlite'),
    paired: use => use({ store: { host: () => ({ fingerprint: active ? host : spare }) }, connection: {
      async postJson(_path, body) {
        receipt = projectCreationDecision(registry, spaceId, laptop, body);
        if (body.action === 'confirm' && lose) { lose = false; return { reachable: false }; }
        return { status: 200, reachable: true, body: receipt };
      }
    } })
  });
  const graph = new Set();
  await assert.rejects(write('sample', () => graph.add('sample')), { code: 'project_reservation_unavailable' });
  assert.equal(registry.ownership().owner('sample').state, 'owned');
  await write('sample', () => graph.add('sample'));
  assert.equal(graph.size, 1);
  const local = open('local.sqlite');
  try {
    assert.equal(local.ownership().rememberPermit(host, laptop, { ...receipt, spaceId: 'other' }).ok, false);
    assert.equal(local.db.prepare('SELECT state FROM project_permits').get().state, 'owned');
  } finally { local.close(); }
  active = false;
  await assert.rejects(write('other', () => assert.fail('must not create')), { code: 'project_reservation_unavailable' });
});
