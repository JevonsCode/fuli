import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApplication } from '../src/app/create-application.js';
import { createServer } from '../src/server.js';
import { FileStore } from '../src/store.js';
import { closeServer, getJson, postJson } from '../test-support/server.js';

test('web API returns compact context packs for local agents', async (t) => {
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
    sourceUri: 'prd://v1',
    body: 'test_url: https://old.example.com'
  });
  await postJson(`${url}/api/remember`, {
    personalSpaceId: personal.space.id,
    targetSpaceId: project.space.id,
    sourceKind: 'prd',
    sourceUri: 'prd://v2',
    body: 'test_url: https://new.example.com'
  });

  const params = new URLSearchParams({
    personalSpaceId: personal.space.id,
    spaceId: project.space.id,
    q: 'test_url'
  });
  const pack = await getJson(`${url}/api/context-pack?${params.toString()}`);

  assert.equal(pack.matches[0].fact.object, 'https://new.example.com');
  assert.equal(pack.histories[0].facts[0].object, 'https://old.example.com');
  assert.equal(pack.histories[0].facts[1].source.uri, 'prd://v2');
  assert.equal(Object.hasOwn(pack, 'episodes'), false);
  assert.equal(Object.hasOwn(pack, 'facts'), false);
});

test('web API can build context packs from space names', async (t) => {
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
    body: 'test_url: https://name-pack.example.com'
  });

  const params = new URLSearchParams({
    personalSpaceName: 'Jevons',
    spaceName: 'Project A',
    q: 'test_url'
  });
  const pack = await getJson(`${url}/api/context-pack?${params.toString()}`);

  assert.equal(pack.personalSpace.name, 'Jevons');
  assert.equal(pack.space.name, 'Project A');
  assert.equal(pack.matches[0].fact.object, 'https://name-pack.example.com');
});

test('web server exposes the packaged Fuli logo as its conventional favicon', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-')), 'context.db');
  const { server, url } = await createServer({ dbPath, port: 0 });
  t.after(() => server.close());

  const response = await fetch(`${url}/favicon.ico`);
  const image = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('web API bootstraps starter spaces for a fresh local user', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-')), 'context.db');
  const { server, url } = await createServer({ dbPath, port: 0 });
  t.after(() => server.close());

  const first = await postJson(`${url}/api/bootstrap`, {});
  const second = await postJson(`${url}/api/bootstrap`, {});
  const state = await getJson(`${url}/api/state`);

  assert.equal(first.personal.name, '我');
  assert.equal(first.space.name, '工作');
  assert.equal(second.personal.id, first.personal.id);
  assert.equal(second.space.id, first.space.id);
  assert.equal(state.spaces.length, 2);
  assert.equal(state.subscriptions.length, 1);
});
