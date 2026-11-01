import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAgentAvatars, MAX_IMAGE_BYTES } from '../src/agent-avatars/port.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handleAgentAvatarsRequest } from '../src/http/agent-avatars-api-router.js';

// rec#11 D-89: an Agent's look as the person chose it. Synthetic pictures only.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('synthetic png body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 synthetic')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function avatarsIn(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-avatars-'));
  let tick = 0;
  const avatars = createAgentAvatars({ path: join(dir, 'agent-avatars.sqlite'),
    now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, tick++)) });
  t.after(() => { avatars.close(); rmSync(dir, { recursive: true, force: true }); });
  return { avatars, path: join(dir, 'agent-avatars.sqlite') };
}

test('a re-roll, an uploaded picture and the default are each the current look in turn', (t) => {
  const { avatars } = avatarsIn(t);
  assert.deepEqual(avatars.list('space-a'), { avatars: [] });
  const rolled = avatars.set({ personalSpaceId: 'space-a', agentId: 'fla-1', look: { kind: 'generated', seed: 'roll-7' } });
  assert.deepEqual(rolled, { agentId: 'fla-1', kind: 'generated', seed: 'roll-7', updatedAt: '2026-11-01T00:00:00.000Z' });
  const uploaded = avatars.set({ personalSpaceId: 'space-a', agentId: 'employee.jefa',
    look: { kind: 'image', data: PNG.toString('base64') } });
  assert.equal(uploaded.kind, 'image');
  assert.match(uploaded.imageVersion, /^[0-9a-f]{16}$/);
  assert.deepEqual(avatars.list('space-a').avatars.map((look) => [look.agentId, look.kind]),
    [['employee.jefa', 'image'], ['fla-1', 'generated']]);
  const picture = avatars.image({ personalSpaceId: 'space-a', agentId: 'employee.jefa' });
  assert.equal(picture.mediaType, 'image/png');
  assert.deepEqual(picture.bytes, PNG);
  // Back to the default: the Agent leaves the list and shows no picture; another space never sees it.
  avatars.set({ personalSpaceId: 'space-a', agentId: 'employee.jefa', look: { kind: 'default' } });
  assert.deepEqual(avatars.list('space-a').avatars.map((look) => look.agentId), ['fla-1']);
  assert.equal(avatars.image({ personalSpaceId: 'space-a', agentId: 'employee.jefa' }), null);
  assert.deepEqual(avatars.list('space-b'), { avatars: [] });
});

test('a picture is a small raster image told by its bytes', (t) => {
  const { avatars } = avatarsIn(t);
  const set = (data) => avatars.set({ personalSpaceId: 'space-a', agentId: 'fla-1', look: { kind: 'image', data } });
  assert.equal(set(WEBP.toString('base64')).kind, 'image');
  assert.equal(avatars.image({ personalSpaceId: 'space-a', agentId: 'fla-1' }).mediaType, 'image/webp');
  for (const data of [SVG.toString('base64'), 'not base64!', '', Buffer.alloc(MAX_IMAGE_BYTES + 1, 0xff).toString('base64')]) {
    assert.throws(() => set(data), { code: 'invalid_input' }, data.slice(0, 20));
  }
  for (const look of [null, { kind: 'emoji' }, { kind: 'generated' }, { kind: 'generated', seed: 'x'.repeat(65) }]) {
    assert.throws(() => avatars.set({ personalSpaceId: 'space-a', agentId: 'fla-1', look }), { code: 'invalid_input' });
  }
  assert.equal(avatars.image({ personalSpaceId: 'space-a', agentId: 'fla-1' }).mediaType, 'image/webp');
});

test('every earlier look stays as it was', (t) => {
  const { avatars, path } = avatarsIn(t);
  avatars.set({ personalSpaceId: 'space-a', agentId: 'fla-1', look: { kind: 'image', data: PNG.toString('base64') } });
  avatars.set({ personalSpaceId: 'space-a', agentId: 'fla-1', look: { kind: 'generated', seed: 'roll-1' } });
  const db = new DatabaseSync(path);
  try {
    assert.deepEqual(db.prepare('SELECT kind FROM agent_avatar_looks ORDER BY id').all().map((row) => row.kind), ['image', 'generated']);
    assert.throws(() => db.exec("UPDATE agent_avatar_looks SET seed = 'x'"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM agent_avatar_images'), /immutable/);
  } finally {
    db.close();
  }
});

function request(method, body, remoteAddress) {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  return Object.assign(stream, { method, headers: { 'content-type': 'application/json' }, socket: { remoteAddress } });
}

async function api(app, method, path, body = null, remoteAddress = '127.0.0.1') {
  const sent = { headers: {} };
  const response = { setHeader(name, value) { sent.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) { sent.status = status; Object.assign(sent.headers, headers); },
    end(payload) { sent.raw = payload; sent.body = typeof payload === 'string' ? JSON.parse(payload) : null; } };
  try {
    sent.handled = await handleAgentAvatarsRequest({ request: request(method, body, remoteAddress), response,
      url: new URL(`http://127.0.0.1${path}`), app });
  } catch (error) {
    Object.assign(sent, mapHttpError(error));
  }
  return sent;
}

test('the console sets a look on this computer and serves a picture by its version', async (t) => {
  const { avatars } = avatarsIn(t);
  const app = { config: { personal: { spaceId: 'space-a' } }, agentAvatars: avatars };
  const look = { kind: 'image', data: PNG.toString('base64') };
  assert.equal((await api(app, 'PUT', '/api/agent-avatars/employee.bole', { personalSpaceId: 'space-a', look }, '10.0.0.8')).status, 403);
  assert.equal((await api(app, 'PUT', '/api/agent-avatars/employee.bole', { personalSpaceId: 'space-b', look })).status, 403);
  const saved = await api(app, 'PUT', '/api/agent-avatars/employee.bole', { personalSpaceId: 'space-a', look });
  assert.equal(saved.status, 200);
  const listed = await api(app, 'GET', '/api/agent-avatars?personalSpaceId=space-a');
  assert.deepEqual(listed.body.avatars.map((item) => item.imageVersion), [saved.body.imageVersion]);
  const picture = await api(app, 'GET', `/api/agent-avatars/employee.bole/image?v=${saved.body.imageVersion}`);
  assert.equal(picture.status, 200);
  assert.deepEqual(picture.raw, PNG);
  assert.equal(picture.headers['content-type'], 'image/png');
  assert.equal(picture.headers['x-content-type-options'], 'nosniff');
  assert.equal((await api(app, 'GET', '/api/agent-avatars/fla-unknown/image')).status, 404);
  assert.equal((await api(app, 'POST', '/api/agent-avatars/employee.bole', {})).handled, false);
});
