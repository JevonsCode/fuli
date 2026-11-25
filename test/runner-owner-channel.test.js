import assert from 'node:assert/strict';
import test from 'node:test';

import { CHUNK_BYTES, ownerChannel } from '../src/runner/owner-channel.js';
import { ownerExport, readOwnerExport } from '../src/runner/owner-export.js';
import { inventoryDigest, inventoryPages, ownerInventory } from '../src/runner/owner-inventory.js';

const device = 'a'.repeat(64);
const job = { owner: device, generation: 1, spaceId: 'sample', scope: 'project:sample', requestId: 'fixture', action: 'inventory' };

test('a live owner poll binds one reply to its peer, space, generation and operation', async () => {
  let allowed = true;
  const lane = ownerChannel({ admit: () => allowed });
  assert.equal((await lane.request(job)).dispatched, false);
  const waiting = lane.pull(device);
  const answer = lane.request(job);
  const { job: request } = await waiting;
  const result = { ...request, value: { ok: true } };
  for (const changes of [{ generation: 2 }, { spaceId: 'other' }, { receiptId: 'unknown' }]) {
    assert.equal(lane.reply(device, { ...result, ...changes }).ok, false);
  }
  assert.equal(lane.reply('b'.repeat(64), result).ok, false);
  assert.equal(lane.reply(device, result).ok, true);
  assert.deepEqual(await answer, { ok: true, dispatched: true, result: { ok: true } });
  assert.equal(lane.reply(device, result).ok, false);
  const next = lane.pull(device);
  const changed = lane.request(job);
  allowed = false;
  assert.equal(lane.reply(device, { ...(await next).job, value: {} }).ok, false);
  assert.equal((await changed).code, 'owner_result_unknown');
  const final = lane.pull(device);
  lane.close();
  assert.equal((await final).job, null);
});

test('a complete paged claim awaits a matching catalog and every individual project proof', () => {
  const reports = [], verified = [];
  const inventory = ownerInventory({ spaceId: () => 'sample', registry: () => ({
    reported: (...args) => reports.push(args), proveClaim: (...args) => { verified.push(args); return true; }
  }) });
  const ids = Array.from({ length: 160 }, (_, i) => 'project-' + i);
  const pages = inventoryPages('sample', ids);
  assert.equal(inventory.accept(device, pages[1]).ok, false);
  for (const n of [0,2,2,1]) assert.equal(inventory.accept(device, pages[n]).ok, true);
  assert.equal(reports.length, 1);
  assert.equal(verified.length, 0);
  const proofs = ids.map(project => ({ project, spaceId: 'sample', owner: device, digest: 'e'.repeat(64) }));
  const catalog = { count: ids.length, digest: inventoryDigest(ids) };
  assert.equal(inventory.acceptsCatalog(device, pages[0].snapshot, { ...catalog, count: 0 }), false);
  assert.equal(inventory.acceptsCatalog(device, pages[0].snapshot, catalog), true);
  assert.equal(inventory.verifyProject(device, pages[0].snapshot, { ...proofs[0], owner: 'another' }, 1), false);
  assert.ok(proofs.every(proof => inventory.verifyProject(device, pages[0].snapshot, proof, 1)));
  assert.equal(verified.length, ids.length);
  const [empty] = inventoryPages('sample', []);
  inventory.accept(device, empty);
  assert.equal(inventory.verifyProject(device, empty.snapshot, proofs[0], 1), false);
  assert.equal(inventory.acceptsCatalog(device, empty.snapshot, { count: 0, digest: inventoryDigest([]) }), true);
});

test('chunked handoff preserves the exact UTF-8 and refuses mixed or retired exports', async () => {
  let owner = true, calls = 0;
  const text = '界'.repeat(CHUNK_BYTES) + '12345678901234567890';
  const source = ownerExport({ owns: () => owner, exportScope: async input => {
    calls++;
    return { text, complete: true, digest: 'b'.repeat(64), scope: input.scope, spaceId: input.spaceId };
  } });
  const summary = await source(job);
  const ask = async (action, input) => ({ ok: true, result: await source({ ...job, action, input }) });
  assert.equal((await readOwnerExport(ask, summary)).text, text);
  assert.equal(calls, 1);
  assert.equal((await readOwnerExport(ask, { ...summary, rawDigest: 'c'.repeat(64) })).ok, false);
  owner = false;
  assert.equal((await readOwnerExport(ask, summary)).ok, false);
});
test('a re-pair invalidates an incomplete or previously verified snapshot and retired pages cannot replace a newer report', () => {
  let epoch = 'first';
  const reports = [];
  const inventory = ownerInventory({ spaceId: () => 'sample', pairing: () => epoch, registry: () => ({
    reported: (_device, ids) => reports.push(ids)
  }) });
  const [original] = inventoryPages('sample', ['first']);
  const [recent] = inventoryPages('sample', ['next']);
  inventory.accept(device, original);
  inventory.accept(device, recent);
  assert.equal(inventory.accept(device, original).ok, false);
  epoch = 'second';
  assert.equal(inventory.pending(device), null);
  assert.equal(inventory.acceptsCatalog(device, recent.snapshot, {}), false);
  assert.equal(inventory.accept(device, original).ok, true);
  assert.deepEqual(reports, [['first'], ['next'], ['first']]);
});

test('an empty prepared graph is opened only for a catalog read, with the preparation lock held through shutdown', async () => {
  const { preparedOwnerCatalog } = await import('../src/runner/owner-catalog.js');
  const events = [];
  const opts = { paths: { dataDir: 'synthetic' }, spaceId: 'sample', current: () => true,
    prepared: () => ({ state: 'ready', createdHere: true, space: { id: 'sample' } }),
    hold: () => { events.push('locked'); return () => events.push('released'); },
    unfinished: () => null, read: () => { events.push('read'); return { count: 0 }; },
    services: () => ({ ready: async () => false, start: async () => events.push('starting'),
      stopDatabases: async () => events.push('stopped') }) };
  assert.deepEqual(await preparedOwnerCatalog(opts), { count: 0 });
  assert.deepEqual(events, ['locked','starting','read','stopped','released']);
  events.length = 0;
  await assert.rejects(preparedOwnerCatalog({ ...opts, current: () => false }));
  assert.deepEqual(events, ['locked','released']);
});
