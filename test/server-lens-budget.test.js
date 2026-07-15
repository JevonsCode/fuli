import assert from 'node:assert/strict';
import test from 'node:test';

import { createApplication } from '../src/app/create-application.js';
import { createServer } from '../src/server.js';
import { STORE_METHODS } from '../src/storage/store-port.js';
import { FileStore } from '../src/store.js';
import { closeServer, getJson, overrideStore, requestJson } from '../test-support/server.js';

test('web lens API enforces public ids and strict bounded budgets', async (t) => {
  const app = createApplication({ store: new FileStore(':memory:') });
  const personal = app.createSpace('我', 'personal');
  const publicSpace = app.createSpace('项目', 'public');
  app.lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'prefers_language',
    value: '中文内容'.repeat(40),
    sourceText: '中文来源'
  });
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => closeServer(server));

  const bounded = await getJson(`${url}/api/lens?personalSpaceId=${personal.id}&budget=32`);
  assert.equal(bounded.budget, 32);
  assert.equal(bounded.usedBytes <= 32, true);
  assert.equal(bounded.usedBytes, Buffer.byteLength(JSON.stringify(bounded.facts), 'utf8'));
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.facts, []);

  const missing = await requestJson(`${url}/api/lens`);
  assert.equal(missing.status, 400);
  const wrongKind = await requestJson(`${url}/api/lens?personalSpaceId=${publicSpace.id}`);
  assert.equal(wrongKind.status, 400);
  for (const budget of ['0', '1', '-1', '1.5', 'NaN', '16385', ' 12']) {
    const response = await requestJson(
      `${url}/api/lens?personalSpaceId=${personal.id}&budget=${encodeURIComponent(budget)}`
    );
    assert.equal(response.status, 400, budget);
    assert.match(response.body.error, /Budget must be/);
  }
});

test('web lens API avoids full scans and lets a later small sourced DTO fit', async (t) => {
  const backing = new FileStore(':memory:');
  const personal = backing.createSpace('我', 'personal');
  const hugeSource = backing.addEpisode(
    personal.id,
    'conversation',
    'safe huge source',
    `chat://${'x'.repeat(1000)}`
  );
  const smallSource = backing.addEpisode(personal.id, 'conversation', 'safe small source');
  backing.addFact({
    id: 'a-huge-source', spaceId: personal.id, subject: 'user', predicate: 'has_boundary',
    object: 'large source', sourceEpisodeId: hugeSource.id,
    validAt: '2026-07-11T02:00:00.000Z'
  });
  backing.addFact({
    id: 'b-small-source', spaceId: personal.id, subject: 'user', predicate: 'prefers_small',
    object: 'small', sourceEpisodeId: smallSource.id,
    validAt: '2026-07-11T01:00:00.000Z'
  });
  const calls = new Map();
  const store = overrideStore(backing, Object.fromEntries(STORE_METHODS.map((method) => [
    method,
    (...args) => {
      calls.set(method, (calls.get(method) ?? 0) + 1);
      return backing[method](...args);
    }
  ])));
  const app = createApplication({ store });
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => closeServer(server));

  const result = await getJson(`${url}/api/lens?personalSpaceId=${personal.id}&budget=260`);

  assert.deepEqual(result.facts.map(({ object }) => object), ['small']);
  assert.equal(result.truncated, true);
  assert.equal(result.usedBytes, Buffer.byteLength(JSON.stringify(result.facts), 'utf8'));
  assert.equal(result.usedBytes <= 260, true);
  assert.equal(calls.get('transaction'), 1);
  assert.equal(calls.get('currentFacts'), 1);
  assert.equal(calls.get('episodeEvidencePreview'), 2);
  for (const method of ['getEpisode', 'searchFacts', 'listFacts', 'listEpisodes']) {
    assert.equal(calls.get(method) ?? 0, 0, method);
  }
});
