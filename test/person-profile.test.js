import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { localStoreFiles } from '../src/data-format/local-stores.js';
import { getCollaborationPreferences } from '../src/graphiti/collaboration-preference-workflow.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handlePersonProfileRequest } from '../src/http/person-profile-api-router.js';
import { createPersonProfile } from '../src/person-profile/port.js';

// The person's own home (「我」): their name and picture, on this computer only.
// Synthetic names and pictures only.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('synthetic png body')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function profileIn(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-person-profile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'person-profile.json');
  let tick = 0;
  return { path, profile: createPersonProfile({ path, now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, tick++)) }) };
}

test('nothing chosen reads as no name and the default face', (t) => {
  const { profile } = profileIn(t);
  assert.deepEqual(profile.view(), { name: '', look: { kind: 'default' }, updatedAt: null });
  assert.equal(profile.addressAs(), '');
  assert.equal(profile.image(), null);
});

test('the name is short plain text, and a change keeps the other field', (t) => {
  const { profile, path } = profileIn(t);
  assert.equal(profile.update({ name: '  Synthetic\nPerson ' }).name, 'Synthetic Person');
  profile.update({ look: { kind: 'generated', seed: 'seed-7' } });
  assert.deepEqual(profile.view(), { name: 'Synthetic Person', look: { kind: 'generated', seed: 'seed-7' },
    updatedAt: '2026-11-02T00:00:01.000Z' });
  assert.equal(profile.addressAs(), 'Synthetic Person');
  assert.equal(profile.update({ name: '小' .repeat(32) }).name.length, 32);
  for (const name of ['小'.repeat(33), 7, 'a\u0000b']) {
    assert.throws(() => profile.update({ name }), { code: 'invalid_input' });
  }
  assert.throws(() => profile.update({}), { code: 'invalid_input' });
  // Clearing the name leaves the look; the file is versioned FULI data.
  profile.update({ name: '' });
  assert.equal(profile.view().look.kind, 'generated');
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.name, '');
});

test('an uploaded picture is a small raster image, and the default face comes back', (t) => {
  const { profile } = profileIn(t);
  const saved = profile.update({ look: { kind: 'image', data: PNG.toString('base64') } });
  assert.match(saved.look.imageVersion, /^[0-9a-f]{16}$/);
  const picture = profile.image();
  assert.equal(picture.mediaType, 'image/png');
  assert.deepEqual(picture.bytes, PNG);
  assert.equal(picture.version, saved.look.imageVersion);
  for (const look of [{ kind: 'image', data: SVG.toString('base64') }, { kind: 'emoji' }, { kind: 'generated' }]) {
    assert.throws(() => profile.update({ look }), { code: 'invalid_input' });
  }
  assert.deepEqual(profile.update({ look: { kind: 'default' } }).look, { kind: 'default' });
  assert.equal(profile.image(), null);
});

test('a file a newer FULI wrote is never overwritten, and a broken one reads as nothing chosen', (t) => {
  const { profile, path } = profileIn(t);
  writeFileSync(path, JSON.stringify({ version: 9, name: 'Future' }));
  assert.equal(profile.addressAs(), '');
  assert.throws(() => profile.update({ name: 'Now' }), { code: 'data_format_blocked' });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 9);
  writeFileSync(path, '{ not json');
  assert.equal(profile.view().name, '');
  assert.equal(profile.update({ name: 'Again' }).name, 'Again');
  assert.ok(localStoreFiles('data').some((store) => store.label === 'person-profile.json'));
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
    sent.handled = await handlePersonProfileRequest({ request: request(method, body, remoteAddress), response,
      url: new URL(`http://127.0.0.1${path}`), app });
  } catch (error) {
    Object.assign(sent, mapHttpError(error));
  }
  return sent;
}

test('only this computer, in the active space, reads or changes the name and picture', async (t) => {
  const { profile } = profileIn(t);
  const app = { config: { personal: { spaceId: 'space-a' } }, personProfile: profile };
  const look = { kind: 'image', data: PNG.toString('base64') };
  for (const [method, path, body] of [['GET', '/api/person-profile?personalSpaceId=space-a'],
    ['PUT', '/api/person-profile', { personalSpaceId: 'space-a', name: 'Remote' }],
    ['GET', '/api/person-profile/image?personalSpaceId=space-a']]) {
    const refused = await api(app, method, path, body, '10.0.0.8');
    assert.equal(refused.status, 403, `${method} ${path}`);
    assert.equal(refused.body.code, 'local_user_only');
  }
  assert.equal((await api(app, 'GET', '/api/person-profile?personalSpaceId=space-b')).status, 403);
  assert.equal((await api(app, 'PUT', '/api/person-profile', { personalSpaceId: 'space-b', name: 'Other' })).status, 403);
  assert.equal(profile.addressAs(), '');

  const named = await api(app, 'PUT', '/api/person-profile', { personalSpaceId: 'space-a', name: 'Synthetic' });
  assert.equal(named.status, 200);
  assert.equal(named.body.name, 'Synthetic');
  assert.equal(named.headers['cache-control'], 'no-store');
  assert.equal((await api(app, 'GET', '/api/person-profile/image?personalSpaceId=space-a')).status, 404);
  const pictured = await api(app, 'PUT', '/api/person-profile', { personalSpaceId: 'space-a', look });
  assert.equal(pictured.body.name, 'Synthetic');
  const picture = await api(app, 'GET', `/api/person-profile/image?personalSpaceId=space-a&v=${pictured.body.look.imageVersion}`);
  assert.equal(picture.status, 200);
  assert.deepEqual(picture.raw, PNG);
  assert.equal(picture.headers['content-type'], 'image/png');
  assert.equal(picture.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual((await api(app, 'GET', '/api/person-profile?personalSpaceId=space-a')).body,
    { name: 'Synthetic', look: { kind: 'image', imageVersion: pictured.body.look.imageVersion }, updatedAt: pictured.body.updatedAt });
  assert.equal((await api(app, 'PUT', '/api/person-profile', { personalSpaceId: 'space-a', name: 'x'.repeat(40) })).status, 400);
  assert.equal((await api(app, 'POST', '/api/person-profile', {})).status, 405);
  assert.equal((await api(app, 'GET', '/api/person-profile/other')).handled, false);
  assert.equal((await api({ config: app.config }, 'GET', '/api/person-profile?personalSpaceId=space-a')).status, 503);
});

test('the change is a local_user_only route and no Agent tool reaches it', () => {
  const entry = agentInterfaceCatalog().uiMutationParity.find(({ route }) => route === 'PUT /api/person-profile');
  assert.equal(entry.access, 'local_user_only');
  assert.match(entry.reason, /address_as/);
});

test('an Agent reads the name as one short context field, only once the person said it', async (t) => {
  const { profile } = profileIn(t);
  const app = { config: { personal: { spaceId: 'space-a' } }, personProfile: profile, personal: {
    collaborationPreferences: async () => ({ personal_space_id: 'space-a', global_preferences: [], effective_preferences: [],
      conflicts: [], source_windows: { candidates_truncated: false, project_ancestors_truncated: false,
        queued_conflicts_truncated: false }, truncated: false })
  } };
  const read = () => getCollaborationPreferences(app, { personalProjectId: null }, { agentInvocation: true }, async () => {});
  assert.equal(Object.hasOwn((await read()).context, 'address_as'), false);
  profile.update({ name: 'Synthetic' });
  const named = await read();
  assert.equal(named.context.address_as, 'Synthetic');
  assert.equal(JSON.stringify(named).includes('look'), false);
});
