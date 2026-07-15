import assert from 'node:assert/strict';
import test from 'node:test';

import { createApplication } from '../src/app/create-application.js';
import { createServer } from '../src/server.js';
import { FileStore, SqliteStore } from '../src/store.js';
import { closeServer, getJson } from '../test-support/server.js';

for (const [storeName, createStore] of [
  ['FileStore', () => new FileStore(':memory:')],
  ['SqliteStore', () => new SqliteStore(':memory:')]
]) {
  test(`web lens API returns a bounded safe current view with sources on ${storeName}`, async (t) => {
    const store = createStore();
    const app = createApplication({ store });
    const personal = app.createSpace('我', 'personal');
    const other = app.createSpace('他人', 'personal');
    const publicSpace = app.createSpace('项目', 'public');
    const source = store.addEpisode(
      personal.id,
      'conversation',
      'private source body',
      'chat://lens/source',
      { privateMetadata: true }
    );
    const confirmed = store.addFact({
      id: 'sk-proj-secret-fact-id-abcdefghijklmnopqrstuvwxyz',
      spaceId: personal.id,
      subject: 'user',
      predicate: 'prefers_language',
      object: '中文',
      status: 'confirmed',
      sourceEpisodeId: source.id,
      validAt: '2026-07-11T01:00:00.000Z'
    });
    const observed = app.lens.submitUserObservation({
      personalSpaceId: personal.id,
      predicate: 'works_on',
      value: 'local runtime',
      evidenceText: 'observed source body',
      inference: 'direct'
    }).fact;
    app.lens.submitUserObservation({
      personalSpaceId: personal.id,
      predicate: 'might_like',
      value: 'suggested value',
      evidenceText: 'suggested source body',
      inference: 'inferred'
    });
    app.lens.rememberUserFact({
      personalSpaceId: personal.id,
      predicate: 'has_secret',
      value: 'restricted secret value',
      sourceText: 'restricted secret source',
      sensitivity: 'restricted'
    });
    app.lens.rememberUserFact({
      personalSpaceId: other.id,
      predicate: 'prefers_language',
      value: 'wrong person',
      sourceText: 'wrong personal source'
    });
    const publicEpisode = store.addEpisode(publicSpace.id, 'docs', 'public source body');
    store.addFact({
      spaceId: publicSpace.id,
      subject: 'project',
      predicate: 'uses_runtime',
      object: 'public value',
      sourceEpisodeId: publicEpisode.id,
      scope: 'public'
    });
    const historical = app.lens.rememberUserFact({
      personalSpaceId: personal.id,
      predicate: 'used_to_like',
      value: 'historical value',
      sourceText: 'historical source body'
    }).fact;
    store.invalidateFact(historical.id);
    const { server, url } = await createServer({ app, port: 0 });
    t.after(() => closeServer(server));

    const result = await getJson(
      `${url}/api/lens?personalSpaceName=${encodeURIComponent('我')}`
    );

    assert.equal(result.personalSpaceId, personal.id);
    assert.equal(result.budget, 1200);
    assert.equal(result.usedBytes, Buffer.byteLength(JSON.stringify(result.facts), 'utf8'));
    assert.equal(result.usedBytes <= result.budget, true);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.facts[0], {
      subject: 'user',
      predicate: 'prefers_language',
      object: '中文',
      status: 'confirmed',
      validAt: '2026-07-11T01:00:00.000Z',
      source: {
        kind: 'conversation',
        uri: 'chat://lens/source',
        createdAt: source.createdAt
      }
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      confirmed.id, observed.id, source.id, 'confidence', 'source body', 'metadata',
      'sourceEpisodeId', 'replacedByFactId', 'sensitivity', 'scope', 'snapshot', 'store', 'path', 'suggested value',
      'restricted secret value', 'historical value', 'wrong person', 'public value'
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  });
}
