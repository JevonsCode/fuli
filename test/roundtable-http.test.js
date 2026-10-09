import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoundtableServer } from '../src/roundtables/server.js';

const owner = { kind: 'owner' };
const input = { goal: 'A and B exchange an unpredictable marker, then agree', mode: 'discussion',
  limits: { maxRounds: 1 }, seats: [{ id: 'a', name: 'A', role: 'moderator', runtime: 'mcp' }, { id: 'b', name: 'B', role: 'specialist', runtime: 'mcp' }] };
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-roundtable-network-'));
  const host = await createRoundtableServer({ dataDir: dir, port: 0 });
  t.after(async () => { await host.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = (path, body, token) => fetch(`${host.url}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { host, post };
}

test('independent network participants exchange A -> B -> A, scopes deny owner actions and revoked seats', async (t) => {
  const { host, post } = await fixture(t);
  const created = await (await post('/api/roundtables', input)).json();
  const roomId = created.room.id;
  const a = host.service.invite({ roomId, seatId: 'a' }, owner).seatToken;
  const b = host.service.invite({ roomId, seatId: 'b' }, owner).seatToken;
  const peer = async (operation, token, body = {}, id = roomId) => {
    const response = await post(`/roundtable-peer/v1/rooms/${id}/${operation}`, body, token);
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  await peer('join', a); await peer('join', b);
  host.service.control({ roomId, action: 'start' }, owner);
  assert.equal(await peer('claim', b), null);
  const first = await peer('claim', a);
  const marker = `network-${crypto.randomUUID()}`;
  const submitted = await peer('submit', a, { ...first, body: marker, idempotencyKey: `turn-${first.attemptId}` });
  assert.equal(submitted.message.body, marker);
  const replay = await peer('submit', a, { ...first, body: marker, idempotencyKey: `turn-${first.attemptId}` });
  assert.equal(replay.message.id, submitted.message.id);
  const second = await peer('claim', b);
  assert.ok(JSON.stringify(second.context).includes(marker));
  await peer('submit', b, { ...second, body: `B verified ${marker}`, idempotencyKey: `turn-${second.attemptId}` });
  const third = await peer('claim', a);
  assert.ok(JSON.stringify(third.context).includes(`B verified ${marker}`));
  await peer('submit', a, { ...third, body: `Synthesis: ${marker}`, idempotencyKey: `turn-${third.attemptId}` });
  const final = await peer('read', b);
  assert.equal(final.room.status, 'concluded'); assert.equal(final.messages.length, 3);
  const other = host.service.create(input, owner).room.id;
  assert.equal((await post(`/roundtable-peer/v1/rooms/${other}/read`, {}, a)).status, 401);
  assert.equal((await post(`/roundtable-peer/v1/rooms/${roomId}/control`, { action: 'start' }, a)).status, 404);
  host.service.revoke({ roomId, seatId: 'b' }, owner);
  assert.equal((await post(`/roundtable-peer/v1/rooms/${roomId}/read`, {}, b)).status, 401);
});

test('owner HTTP requires local authority and JSON bounds; peer does not inherit owner tools', async (t) => {
  const { host } = await fixture(t);
  const response = await fetch(`${host.url}/api/roundtables`, { method: 'POST', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 403);
  assert.equal((await fetch(`${host.url}/roundtable-peer/v1/rooms/fake/read`, { method: 'POST', body: '{}' })).status, 401);
  const large = await fetch(`${host.url}/api/roundtables`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'x'.repeat(70_000) }) });
  assert.equal(large.status, 413);
});
