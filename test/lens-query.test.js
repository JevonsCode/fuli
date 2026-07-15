import assert from 'node:assert/strict';
import test from 'node:test';

import { LensQuery, BOUNDARY_PREDICATES, BOUNDARY_PREFIXES } from '../src/lens/lens-query.js';
import { LensService } from '../src/lens/lens-service.js';
import { FactScope, FactStatus, SpaceKind } from '../src/models.js';
import { FileStore, SqliteStore } from '../src/store.js';

test('LensQuery defines and prioritizes explicit boundary predicates and prefixes', () => {
  assert.ok(BOUNDARY_PREDICATES.includes('has_boundary'));
  assert.ok(BOUNDARY_PREFIXES.includes('boundary_'));
});

test('getUserLens uses stable ids for equal ranking ties', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const firstEpisode = store.addEpisode(personal.id, 'conversation', 'first');
  const secondEpisode = store.addEpisode(personal.id, 'conversation', 'second');
  store.addFact({
    id: 'fact-b',
    spaceId: personal.id,
    subject: 'user',
    predicate: 'prefers_one',
    object: 'same',
    sourceEpisodeId: firstEpisode.id,
    validAt: '2026-07-10T00:00:00.000Z'
  });
  store.addFact({
    id: 'fact-a',
    spaceId: personal.id,
    subject: 'user',
    predicate: 'prefers_two',
    object: 'same',
    sourceEpisodeId: secondEpisode.id,
    validAt: '2026-07-10T00:00:00.000Z'
  });

  const result = new LensQuery(store).getUserLens({
    personalSpaceId: personal.id,
    task: 'same',
    budget: 1000
  });
  assert.deepEqual(result.facts.map((fact) => fact.id), ['fact-a', 'fact-b']);
  store.close();
});

test('getUserLens skips an oversized top-ranked fact and keeps later facts within budget', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const source = store.addEpisode(personal.id, 'conversation', 'budget source');
  store.addFact({
    id: 'oversized-boundary',
    spaceId: personal.id,
    subject: 'user',
    predicate: 'has_boundary',
    object: 'x'.repeat(17 * 1024),
    sourceEpisodeId: source.id
  });
  store.addFact({
    id: 'small-preference',
    spaceId: personal.id,
    subject: 'user',
    predicate: 'prefers_small',
    object: 'small value',
    sourceEpisodeId: source.id
  });

  const result = new LensQuery(store).getUserLens({
    personalSpaceId: personal.id,
    task: '',
    budget: 16 * 1024
  });
  assert.deepEqual(result.facts.map(({ id }) => id), ['small-preference']);
  assert.equal(result.text.includes('small value'), true);
  assert.equal(result.text.includes('oversized-boundary'), false);
  assert.equal(result.truncated, true);
  store.close();
});

test('getUserLens ranks deterministically, excludes suggested facts, and respects UTF-8 line budgets', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const other = store.createSpace('另一人', SpaceKind.PERSONAL);
  const lens = new LensService(store);
  const query = new LensQuery(store);
  const boundary = lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'has_boundary',
    value: 'never expose private context',
    sourceText: '我的边界是不公开私人上下文'
  }).fact;
  const exact = lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'prefers_language',
    value: 'JavaScript architecture',
    sourceText: '我偏好 JavaScript architecture'
  }).fact;
  const observed = lens.submitUserObservation({
    personalSpaceId: personal.id,
    predicate: 'works_on',
    value: 'JavaScript',
    evidenceText: '用户正在做 JavaScript 项目',
    inference: 'direct'
  }).fact;
  const suggested = lens.submitUserObservation({
    personalSpaceId: personal.id,
    predicate: 'likes_style',
    value: 'architecture',
    evidenceText: '可能喜欢 architecture',
    inference: 'inferred'
  }).fact;
  lens.rememberUserFact({
    personalSpaceId: other.id,
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '另一人的 JavaScript 偏好'
  });

  const full = query.getUserLens({
    personalSpaceId: personal.id,
    task: 'JavaScript architecture',
    budget: 1000
  });
  assert.deepEqual(full.facts.map((fact) => fact.id), [boundary.id, exact.id, observed.id]);
  assert.equal(full.facts.some((fact) => fact.id === suggested.id), false);
  assert.match(full.text, /has_boundary/);
  assert.match(full.text, /JavaScript architecture/);
  assert.equal(full.estimatedTokens, Buffer.byteLength(full.text, 'utf8'));

  const observedOnly = query.getUserLens({
    personalSpaceId: personal.id,
    task: 'JavaScript',
    budget: 1000,
    includeObserved: false,
    includeSuggested: true
  });
  assert.equal(observedOnly.facts.some((fact) => fact.status === FactStatus.OBSERVED), false);
  assert.equal(observedOnly.facts.some((fact) => fact.status === FactStatus.SUGGESTED), true);

  const chineseLine = `${boundary.subject} ${boundary.predicate} ${boundary.object} (${boundary.status})`;
  const exactBoundary = Buffer.byteLength(chineseLine, 'utf8');
  const atBoundary = query.getUserLens({
    personalSpaceId: personal.id,
    task: '边界',
    budget: exactBoundary
  });
  assert.deepEqual(atBoundary.facts.map((fact) => fact.id), [boundary.id]);
  assert.equal(atBoundary.truncated, true);
  assert.ok(Buffer.byteLength(atBoundary.text, 'utf8') <= exactBoundary);
  const overlong = query.getUserLens({ personalSpaceId: personal.id, task: '边界', budget: 1 });
  assert.deepEqual(overlong.facts, []);
  assert.equal(overlong.text, '');
  assert.equal(overlong.truncated, true);
  store.close();
});

for (const [name, createStore] of [
  ['FileStore', () => new FileStore(':memory:')],
  ['SqliteStore', () => new SqliteStore(':memory:')]
]) {
  test(`${name} searchUserContext returns personal source-backed history only`, () => {
    const store = createStore();
    const personal = store.createSpace('我', SpaceKind.PERSONAL);
    const publicSpace = store.createSpace('工作', SpaceKind.PUBLIC);
    const lens = new LensService(store);
    const original = lens.rememberUserFact({
      personalSpaceId: personal.id,
      predicate: 'prefers_language',
      value: 'JavaScript',
      sourceText: '我熟悉 JavaScript'
    }).fact;
    const replacement = lens.correctUserFact({
      personalSpaceId: personal.id,
      factId: original.id,
      action: 'replace',
      value: 'TypeScript',
      sourceText: '现在更偏好 TypeScript'
    }).fact;
    const publicEpisode = store.addEpisode(publicSpace.id, 'prd', 'JavaScript is public');
    store.addFact({
      spaceId: publicSpace.id,
      subject: '工作',
      predicate: 'uses',
      object: 'JavaScript',
      sourceEpisodeId: publicEpisode.id,
      scope: FactScope.PUBLIC
    });
    const query = new LensQuery(store);

    const current = query.searchUserContext({
      personalSpaceId: personal.id,
      query: 'TypeScript'
    });
    assert.equal(current.facts.length, 1);
    assert.equal(current.facts[0].fact.id, replacement.id);
    assert.equal(current.facts[0].sourceEpisode.id, replacement.sourceEpisodeId);
    assert.equal(current.facts[0].sourceEpisode.body, '现在更偏好 TypeScript');
    assert.equal(current.facts[0].replacementFact, null);
    assert.equal(current.facts[0].correctionEpisodes.length, 0);

    const history = query.searchUserContext({
      personalSpaceId: personal.id,
      query: 'JavaScript',
      includeHistorical: true
    });
    assert.equal(history.facts.length, 1);
    assert.equal(history.facts[0].fact.id, original.id);
    assert.equal(history.facts[0].replacementFact.id, replacement.id);
    assert.equal(history.facts[0].correctionEpisodes[0].metadata.factId, original.id);
    assert.equal(history.facts[0].sourceEpisode.body, '我熟悉 JavaScript');
    assert.equal(history.facts.some((item) => item.fact.spaceId === publicSpace.id), false);
    store.close();
  });
}

test('LensQuery validates personal space and bounded inputs', () => {
  const store = new FileStore(':memory:');
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const publicSpace = store.createSpace('工作', SpaceKind.PUBLIC);
  const query = new LensQuery(store);
  assert.throws(() => query.getUserLens({ personalSpaceId: publicSpace.id, task: 'x', budget: 1 }), /not personal/i);
  assert.throws(() => query.getUserLens({ personalSpaceId: personal.id, task: 'x', budget: 0 }), /budget/i);
  assert.throws(() => query.getUserLens({ personalSpaceId: personal.id, task: 'x', budget: 1.5 }), /budget/i);
  assert.throws(() => query.searchUserContext({ personalSpaceId: personal.id, query: 4 }), /query/i);
  store.close();
});
