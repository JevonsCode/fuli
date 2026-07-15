import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApplication } from '../src/app/create-application.js';
import { createServer } from '../src/server.js';
import { FileStore } from '../src/store.js';
import { closeServer, getJson, postJson, requestJson } from '../test-support/server.js';

test('web API maps malformed JSON to a bad request', async (t) => {
  const { server, url } = await createServer({
    store: new FileStore(':memory:'),
    port: 0
  });
  t.after(() => server.close());

  const response = await fetch(`${url}/api/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":'
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Malformed JSON' });
});

test('web API never exposes unexpected database details', async () => {
  const privateError = 'SQLITE_CONSTRAINT facts secret-token C:\\private\\context.db';
  const app = {
    state() {
      throw new Error(privateError);
    }
  };
  const { server, url } = await createServer({ app, port: 0 });
  try {
    const response = await requestJson(`${url}/api/state`);
    const serialized = JSON.stringify(response.body);
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: 'Internal server error' });
    assert.equal(serialized.includes('SQLITE'), false);
    assert.equal(serialized.includes('facts'), false);
    assert.equal(serialized.includes('secret-token'), false);
    assert.equal(serialized.includes('context.db'), false);
  } finally {
    await closeServer(server);
  }
});

test('web API maps application validation errors without transport internals', async (t) => {
  const app = createApplication({ store: new FileStore(':memory:') });
  const { personal, space } = app.bootstrap();
  const candidate = app.remember({
    personalSpaceId: personal.id,
    targetSpaceId: space.id,
    sourceKind: 'chat',
    body: 'maybe split this module later'
  }).candidate;
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => {
    server.close();
    app.close();
  });

  const response = await requestJson(`${url}/api/candidates/${candidate.id}/decision`, {
    method: 'POST',
    body: { decision: 'archive' }
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: 'Unknown candidate decision: archive' });
});

test('web API creates spaces, subscribes, remembers, and searches', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-')), 'context.db');
  const { server, url } = await createServer({ dbPath, port: 0 });
  t.after(() => server.close());

  const personal = await postJson(`${url}/api/spaces`, { name: 'Jevons', kind: 'personal' });
  const project = await postJson(`${url}/api/spaces`, { name: 'Project A', kind: 'public' });
  await postJson(`${url}/api/subscriptions`, {
    personalSpaceId: personal.space.id,
    spaceId: project.space.id
  });
  await postJson(`${url}/api/remember`, {
    personalSpaceId: personal.space.id,
    targetSpaceId: project.space.id,
    sourceKind: 'prd',
    body: 'test_url: https://test.example.com'
  });

  const search = await getJson(`${url}/api/search?personalSpaceId=${personal.space.id}&q=test_url`);
  const state = await getJson(`${url}/api/state`);

  assert.equal(search.facts[0].object, 'https://test.example.com');
  assert.equal(state.spaces.length, 4);
  assert.equal(state.currentFacts.length, 1);
});

test('web API can remember and search by space names', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-')), 'context.db');
  const { server, url } = await createServer({ dbPath, port: 0 });
  t.after(() => server.close());

  const personal = await postJson(`${url}/api/spaces`, { name: 'Jevons', kind: 'personal' });
  const project = await postJson(`${url}/api/spaces`, { name: 'Project A', kind: 'public' });
  await postJson(`${url}/api/subscriptions`, {
    personalSpaceId: personal.space.id,
    spaceId: project.space.id
  });
  const remembered = await postJson(`${url}/api/remember`, {
    personalSpaceName: 'Jevons',
    targetSpaceName: 'Project A',
    sourceKind: 'prd',
    body: 'api_base: https://name-api.example.com'
  });

  const params = new URLSearchParams({
    personalSpaceName: 'Jevons',
    q: 'api_base'
  });
  const search = await getJson(`${url}/api/search?${params.toString()}`);

  assert.equal(remembered.route, 'public');
  assert.equal(search.matches[0].spaceName, 'Project A');
  assert.equal(search.matches[0].fact.object, 'https://name-api.example.com');
});

test('web API returns clear errors for unknown spaces', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-')), 'context.db');
  const { server, url } = await createServer({ dbPath, port: 0 });
  t.after(() => server.close());

  await postJson(`${url}/api/spaces`, { name: 'Jevons', kind: 'personal' });
  await postJson(`${url}/api/spaces`, { name: 'Project A', kind: 'public' });

  const remember = await requestJson(`${url}/api/remember`, {
    method: 'POST',
    body: {
      personalSpaceName: 'Missing',
      targetSpaceName: 'Project A',
      sourceKind: 'prd',
      body: 'api_base: https://bad.example.com'
    }
  });
  const search = await requestJson(`${url}/api/search?personalSpaceName=Missing&q=api_base`);
  const pack = await requestJson(
    `${url}/api/context-pack?personalSpaceName=Jevons&spaceName=Missing&q=api_base`
  );

  assert.equal(remember.status, 400);
  assert.equal(remember.body.error, 'Personal space not found: Missing');
  assert.equal(search.status, 400);
  assert.equal(search.body.error, 'Personal space not found: Missing');
  assert.equal(pack.status, 400);
  assert.equal(pack.body.error, 'Space not found: Missing');
});
