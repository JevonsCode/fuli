import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RunnerHostStore } from '../src/runner/host-store.js';
import { RUNNER_HOST_FORMAT } from '../src/runner/host-store.js';
import { openFormattedDatabase, sqliteFormat } from '../packages/roundtable/src/storage/database-format.js';
import { invitationCodeHash } from '../src/runner/protocol.js';

const device = 'a'.repeat(64);
const other = 'b'.repeat(64);
const space = 'sample-space';

function fixture(t, file = ':memory:') {
  let current = space;
  const store = new RunnerHostStore(file, { spaceId: () => current });
  t.after(() => store.close());
  const joinDevice = (scopes, fingerprint = device) => {
    const code = randomUUID();
    store.invite({ code, name: 'Sample laptop', scopes });
    assert.ok(store.pair({ code, fingerprint }));
    return store.grants(fingerprint);
  };
  return { store, joinDevice, setSpace: value => { current = value; } };
}

test('a project request is durable, a decision belongs to the displayed revision and pairing', t => {
  const { store, joinDevice } = fixture(t);
  const grants = joinDevice(['project:alpha']);
  assert.equal(grants.unrestricted(), false);
  assert.equal(grants.allowed('project:alpha'), true);
  assert.equal(grants.allowed('global'), false);
  const first = grants.request('project:beta');
  assert.deepEqual(grants.request('project:beta'), first);
  const allowed = grants.decide({ ...first, state: 'allowed' });
  assert.equal(allowed.version, 2);
  assert.equal(grants.allowed('project:beta'), true);
  assert.equal(grants.decide({ ...first, state: 'revoked' }).code, 'decision_changed');
  store.ownership().verified(device, ['original']);
  store.revoke(device);
  assert.equal(grants.allowed('project:beta'), false);
  const next = joinDevice([]);
  assert.equal(store.ownership().owner('original').owner, device);
  assert.equal(store.ownership().reserve(device, 'fresh', 'attempt').code, 'inventory_incomplete');
  store.ownership().verified(device, ['original']);
  assert.equal(store.ownership().reserve(device, 'fresh', 'attempt').ok, true);
  assert.equal(next.allowed('project:alpha'), false);
  assert.equal(next.decide({ ...allowed, state: 'allowed' }).code, 'pairing_changed');
  assert.equal(next.list().scopes.length, 0);
});

test('a wildcard allows the original scopes until the person revokes a specific exception', t => {
  const { joinDevice, store, setSpace } = fixture(t);
  const grants = joinDevice();
  const { pairing } = grants.list();
  assert.equal(grants.unrestricted(), true);
  assert.equal(grants.decide({ pairing, scope: 'project:beta', version: 0, state: 'revoked' }).ok, true);
  assert.equal(grants.request('project:beta').state, 'revoked');
  assert.equal(grants.allowed('project:alpha'), true);
  assert.equal(grants.allowed('project:beta'), false);
  assert.equal(grants.unrestricted(), false);
  for (const scope of ['default', '*', null, 'project:']) assert.equal(grants.allowed(scope), false);
  setSpace('other-space');
  assert.equal(store.grants(device).allowed('project:alpha'), false);
  const code = randomUUID();
  store.invite({ code, name: 'Another sample', scopes: [] });
  setSpace(space);
  assert.equal(store.pair({ code, fingerprint: other }), null);
});

test('an upgraded store preserves only active old pairings and live unused invitations in its original space', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-scope-grants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'host.sqlite');
  const old = sqliteFormat({ store: RUNNER_HOST_FORMAT.store, schema: RUNNER_HOST_FORMAT.schema,
    migrations: RUNNER_HOST_FORMAT.migrations.slice(0, 2) });
  const db = openFormattedDatabase(file, old);
  const live = randomUUID();
  const dead = randomUUID();
  try {
    const runner = db.prepare('INSERT INTO runners(fingerprint,name,paired_at,revoked_at) VALUES(?,?,?,?)');
    runner.run(device, 'Current sample', '2025-01-01', null);
    runner.run(other, 'Retired sample', '2025-01-01', '2025-02-01');
    const invite = db.prepare('INSERT INTO invitations(code_hash,name,created_at,expires_at) VALUES(?,?,?,?)');
    invite.run(invitationCodeHash(live), 'Active invitation', '2025-01-01', '9999-01-01');
    invite.run(invitationCodeHash(dead), 'Expired invitation', '2025-01-01', '2025-02-01');
  } finally { db.close(); }
  const store = new RunnerHostStore(file, { spaceId: () => space });
  try {
    assert.equal(store.grants(device).unrestricted(), true);
    assert.equal(store.grants(other).unrestricted(), false);
    assert.equal(store.pair({ code: dead, fingerprint: other }), null);
    assert.ok(store.pair({ code: live, fingerprint: other }));
    assert.equal(store.grants(other).unrestricted(), true);
  } finally { store.close(); }
  const next = new RunnerHostStore(file, { spaceId: () => 'another-space' });
  try { assert.equal(next.grants(device).unrestricted(), false); } finally { next.close(); }
});

test('retiring an unchecked revoked device preserves every known claim and prevents re-pairing', t => {
  const { store, joinDevice } = fixture(t);
  const pairing = joinDevice().pairing();
  const ledger = store.ownership();
  ledger.verified(other, ['existing']);
  ledger.reported(device, ['reserved-before-disconnect']);
  assert.equal(ledger.reserve(other, 'fresh', 'fresh').code, 'inventory_incomplete');
  assert.equal(ledger.retireInventory(device, pairing).code, 'pairing_changed');
  store.revoke(device);
  assert.equal(ledger.retireInventory(device, 'stale-pairing').code, 'pairing_changed');
  const prior = ledger.owner('reserved-before-disconnect');
  const result = ledger.retireInventory(device, pairing);
  assert.ok(result.retiredAt);
  assert.deepEqual(ledger.retireInventory(device, pairing), result);
  assert.deepEqual(ledger.owner('reserved-before-disconnect'), prior);
  assert.equal(ledger.reserve(other, 'fresh', 'fresh').ok, true);
  const code = randomUUID();
  store.invite({ code, name: 'New computer' });
  assert.equal(store.pair({ code, fingerprint: device }), null);
  assert.ok(store.pair({ code, fingerprint: 'c'.repeat(64) }));
});
