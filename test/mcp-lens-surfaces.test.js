import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FactScope, FactStatus, Sensitivity, SpaceKind } from '../src/models.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { connectMcp } from '../test-support/mcp-client.js';

const SECRET = 'sk-live-12345678901234567890';
const RESTRICTED = 'restricted-health-marker';
const SOURCE_BODY = 'full-source-body-must-stay-hidden';
const CORRECTION_BODY = 'full-correction-body-must-stay-hidden';
const RESOURCE_URIS = [
  'fuli://lens/current',
  'fuli://lens/history',
  'fuli://spaces/subscribed'
];

test('stdio MCP exposes the active interview prompt and safe Personal Lens resources', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-lens-surfaces-')), 'context.db');
  const fixture = seedFixture(dbPath);
  const connection = await connectMcp(dbPath, { personalSpaceName: fixture.active.name });
  t.after(() => connection.close());

  await assertInterviewPrompt(connection.client);
  const listed = await connection.client.listResources();
  assert.deepEqual(listed.resources.map(({ uri }) => uri).sort(), [...RESOURCE_URIS].sort());
  assert.equal(listed.resources.every(({ mimeType }) => mimeType === 'application/json'), true);
  assert.match(
    listed.resources.find(({ uri }) => uri === RESOURCE_URIS[1]).description,
    /budget\.itemsBytes.*items.*UTF-8/i
  );

  const current = await readJson(connection.client, RESOURCE_URIS[0]);
  assert.equal(current.personalSpaceId, fixture.active.id);
  assert.equal(current.facts.some(({ id }) => id === 'confirmed-visible'), true);
  assert.equal(current.facts.some(({ id }) => id === 'observed-visible'), true);
  assert.equal(current.facts.some(({ status }) => status === FactStatus.SUGGESTED), false);
  assert.equal(current.facts.some(({ id }) => [
    'restricted-hidden', 'secret-hidden', 'other-hidden'
  ].includes(id)), false);
  assert.equal(current.facts.some(({ object }) => object === 'unsafe-current-line-marker'), false);
  assert.doesNotMatch(current.text, /unsafe-current-line-marker/);
  assert.equal(current.facts.some(({ id }) => id === 'oversized-current-boundary'), false);
  assert.match(current.text, /confirmed-visible-value/);
  assert.match(current.text, /observed-visible-value/);
  assert.deepEqual(current.budget, {
    encoding: 'utf-8',
    limitBytes: 16384,
    usedBytes: Buffer.byteLength(current.text, 'utf8')
  });
  assert.equal(current.truncated, true);
  assert.deepEqual(Object.keys(current.facts[0]).sort(), [
    'confidence', 'id', 'object', 'predicate', 'status', 'subject', 'validAt'
  ]);
  assertSafeProjection(current, fixture);

  const history = await readJson(connection.client, RESOURCE_URIS[1]);
  assert.equal(history.personalSpaceId, fixture.active.id);
  assert.equal(history.limit, 100);
  assert.equal(history.count, 100);
  assert.equal(history.truncated, true);
  assert.deepEqual(history.budget, {
    encoding: 'utf-8',
    limitBytes: 64 * 1024,
    itemsBytes: Buffer.byteLength(JSON.stringify(history.items), 'utf8')
  });
  assert.ok(Buffer.byteLength(JSON.stringify(history), 'utf8') <= history.budget.limitBytes);
  assert.equal(history.items.some(({ fact }) => fact.id === 'post-huge-small'), true);
  assert.equal(history.items.some(({ fact }) => fact.id.startsWith('oversized-history-')), false);
  assert.deepEqual(
    history.items.map(({ fact }) => fact.validAt),
    history.items.map(({ fact }) => fact.validAt).toSorted().reverse()
  );
  const corrected = history.items.find(({ fact }) => fact.id === 'corrected-original');
  assert.equal(corrected.current, false);
  assert.equal(corrected.source.id, fixture.originalSource.id);
  assert.deepEqual(Object.keys(corrected.source).sort(), ['createdAt', 'id', 'kind', 'uri']);
  assert.equal(corrected.replacementFact.id, 'corrected-replacement');
  assert.deepEqual(corrected.correctionEpisodes, [{
    id: fixture.correctionEpisode.id,
    kind: 'correction',
    uri: null,
    createdAt: fixture.correctionEpisode.createdAt,
    action: 'replace'
  }]);
  assert.equal(history.items.some(({ fact }) => fact.id === 'history-104'), true);
  assert.equal(history.items.some(({ fact }) => fact.id === 'history-000'), false);
  assert.equal(history.items.some(({ fact }) => fact.status === FactStatus.SUGGESTED), true);
  assert.equal(history.items.find(({ fact }) => fact.id === 'unsafe-source-id').source, null);
  assert.equal(history.items.find(({ fact }) => fact.id === 'unsafe-source-uri').source, null);
  assertSafeProjection(history, fixture);

  const subscribed = await readJson(connection.client, RESOURCE_URIS[2]);
  assert.equal(subscribed.personalSpaceId, fixture.active.id);
  assert.deepEqual(subscribed.subscriptions, [
    {
      space: {
        id: fixture.publicSpace.id,
        name: fixture.publicSpace.name,
        kind: SpaceKind.PUBLIC,
        description: fixture.publicSpace.description
      },
      mode: 'latest',
      createdAt: fixture.activeSubscription.createdAt
    },
    {
      space: {
        id: fixture.unsafePublic.id,
        name: fixture.unsafePublic.name,
        kind: SpaceKind.PUBLIC
      },
      mode: 'latest',
      createdAt: fixture.unsafeSubscription.createdAt
    }
  ]);
  assertSafeProjection(subscribed, fixture);

  await connection.close();
});

test('history reports projection filtering as truncation below the item cap', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-lens-filtered-')), 'context.db');
  const store = new SqliteStore(dbPath);
  const personal = store.createSpace('Filtered User', SpaceKind.PERSONAL);
  const source = store.addEpisode(personal.id, 'conversation', 'safe source');
  addFact(store, personal.id, source.id, {
    id: 'safe-history-only', object: 'safe history', status: FactStatus.DEPRECATED,
    validAt: '2026-01-01T00:00:00.000Z', invalidAt: '2026-01-02T00:00:00.000Z'
  });
  const snapshot = store.exportSnapshot();
  snapshot.facts.push(factRecord({
    id: `unsafe-${SECRET}`,
    spaceId: personal.id,
    sourceEpisodeId: source.id,
    object: 'filtered history',
    status: FactStatus.DEPRECATED,
    validAt: '2026-01-03T00:00:00.000Z',
    invalidAt: '2026-01-04T00:00:00.000Z'
  }));
  store.importSnapshot(snapshot);
  store.close();

  const connection = await connectMcp(dbPath, { personalSpaceName: personal.name });
  t.after(() => connection.close());
  const history = await readJson(connection.client, RESOURCE_URIS[1]);
  assert.equal(history.count, 1);
  assert.equal(history.truncated, true);
  assert.deepEqual(history.items.map(({ fact }) => fact.id), ['safe-history-only']);
  assert.ok(Buffer.byteLength(JSON.stringify(history), 'utf8') <= history.budget.limitBytes);
  assertSafeProjection(history, { hiddenReplacement: { id: 'not-present' }, other: {}, otherPublic: {} });
  await connection.close();
});

async function assertInterviewPrompt(client) {
  const listed = await client.listPrompts();
  assert.equal(listed.prompts.length, 1);
  assert.equal(listed.prompts[0].name, 'get_to_know_me');
  assert.match(listed.prompts[0].description, /稳定|偏好/);
  const result = await client.getPrompt({ name: 'get_to_know_me', arguments: {} });
  const text = result.messages.map(({ content }) => content.text).join('\n');
  assert.match(text, /get_user_lens/);
  assert.match(text, /认识用户并补足稳定、跨项目偏好/);
  assert.match(text, /16384/);
  assert.match(text, /confirmed[\s\S]*observed[\s\S]*suggested/i);
  for (const domain of [
    '沟通方式', '语气', '输出结构', '技术深度', '学习偏好',
    '质量优先级', '协作方式', '环境', '边界'
  ]) assert.match(text, new RegExp(domain));
  assert.match(text, /一次只问一个问题/);
  assert.match(text, /允许.{0,8}跳过/);
  assert.match(text, /不要.{0,12}表单/);
  assert.match(text, /remember_user_fact/);
  assert.match(text, /submit_user_observation/);
  assert.match(text, /永不自行.{0,12}confirm|绝不自行.{0,12}确认/);
  assert.match(text, /凭据/);
  assert.match(text, /精确住址/);
  assert.match(text, /健康数据/);
  assert.match(text, /correct_user_fact/);
  assert.match(text, /不重复已知内容/);
  assert.match(text, /不强迫用户完成全部问题/);
}

async function readJson(client, uri) {
  const result = await client.readResource({ uri });
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].uri, uri);
  assert.equal(result.contents[0].mimeType, 'application/json');
  return JSON.parse(result.contents[0].text);
}

function seedFixture(dbPath) {
  const store = new SqliteStore(dbPath);
  const active = store.createSpace('Active User', SpaceKind.PERSONAL);
  const other = store.createSpace('Other User', SpaceKind.PERSONAL);
  const publicSpace = store.createSpace('Shared Project', SpaceKind.PUBLIC, 'public description');
  const otherPublic = store.createSpace('Other Project', SpaceKind.PUBLIC);
  const unsafePublic = store.createSpace(
    'Unsafe Project',
    SpaceKind.PUBLIC,
    `credential ${SECRET}`
  );
  const unsafeNamePublic = store.createSpace(`Project ${SECRET}`, SpaceKind.PUBLIC);
  const unsafeModePublic = store.createSpace('Unsafe Mode Project', SpaceKind.PUBLIC);
  const unsafeDatePublic = store.createSpace('Unsafe Date Project', SpaceKind.PUBLIC);
  const activeSubscription = store.subscribe(active.id, publicSpace.id, 'latest');
  store.subscribe(active.id, other.id, 'all');
  const unsafeSubscription = store.subscribe(active.id, unsafePublic.id, 'latest');
  store.subscribe(active.id, unsafeNamePublic.id, 'latest');
  store.subscribe(active.id, unsafeModePublic.id, SECRET);
  store.subscribe(active.id, unsafeDatePublic.id, 'latest');
  store.subscribe(other.id, otherPublic.id, 'all');

  const safeSource = store.addEpisode(active.id, 'conversation', SOURCE_BODY, 'chat://safe');
  const originalSource = store.addEpisode(active.id, 'conversation', SOURCE_BODY, 'chat://original');
  const restrictedSource = store.addEpisode(active.id, 'legacy', RESTRICTED);
  const secretSource = store.addEpisode(active.id, 'legacy', `credential ${SECRET}`);
  const otherSource = store.addEpisode(other.id, 'conversation', 'other personal source');

  addFact(store, active.id, safeSource.id, {
    id: 'confirmed-visible', object: 'confirmed-visible-value', validAt: '2026-01-02T00:00:00.000Z'
  });
  addFact(store, active.id, safeSource.id, {
    id: 'oversized-current-boundary', predicate: 'has_boundary',
    object: 'b'.repeat(17 * 1024), validAt: '2101-01-01T00:00:00.000Z'
  });
  addFact(store, active.id, safeSource.id, {
    id: 'observed-visible', object: 'observed-visible-value', status: FactStatus.OBSERVED,
    validAt: '2026-01-01T00:00:00.000Z'
  });
  const unsafeUriSource = store.addEpisode(
    active.id,
    'conversation',
    'safe source with unsafe uri',
    `chat://${SECRET}`
  );
  addFact(store, active.id, unsafeUriSource.id, {
    id: 'unsafe-source-uri', object: 'safe-source-uri-item', status: FactStatus.DEPRECATED,
    validAt: '2099-08-01T00:00:00.000Z', invalidAt: '2099-08-02T00:00:00.000Z'
  });
  addFact(store, active.id, safeSource.id, {
    id: 'suggested-hidden', object: 'suggested-history-value', status: FactStatus.SUGGESTED,
    validAt: '2099-06-01T00:00:00.000Z'
  });
  addFact(store, active.id, restrictedSource.id, {
    id: 'restricted-hidden', object: RESTRICTED, sensitivity: Sensitivity.RESTRICTED
  });
  addFact(store, active.id, secretSource.id, {
    id: 'secret-hidden', object: SECRET
  });
  addFact(store, other.id, otherSource.id, {
    id: 'other-hidden', object: 'other-personal-value'
  });

  const replacement = addFact(store, active.id, safeSource.id, {
    id: 'corrected-replacement', object: 'new-value', validAt: '2100-01-02T00:00:00.000Z'
  });
  addFact(store, active.id, originalSource.id, {
    id: 'corrected-original', object: 'old-value', validAt: '2100-01-01T00:00:00.000Z',
    invalidAt: '2100-01-02T00:00:00.000Z', replacedByFactId: replacement.id
  });
  const correctionEpisode = store.addEpisode(
    active.id,
    'correction',
    CORRECTION_BODY,
    null,
    { kind: 'lens_correction', factId: 'corrected-original', action: 'replace' }
  );
  for (let index = 0; index < 105; index += 1) {
    addFact(store, active.id, safeSource.id, {
      id: `history-${String(index).padStart(3, '0')}`,
      object: `history-value-${index}`,
      status: FactStatus.DEPRECATED,
      validAt: new Date(Date.UTC(2090, 0, 1, 0, 0, index)).toISOString(),
      invalidAt: new Date(Date.UTC(2091, 0, 1, 0, 0, index)).toISOString()
    });
  }
  const hiddenReplacement = addFact(store, active.id, restrictedSource.id, {
    id: 'hidden-replacement-id', object: RESTRICTED, sensitivity: Sensitivity.RESTRICTED,
    validAt: '2099-01-02T00:00:00.000Z'
  });
  addFact(store, active.id, safeSource.id, {
    id: 'safe-hidden-relation', object: 'safe relation value',
    validAt: '2099-01-01T00:00:00.000Z', replacedByFactId: hiddenReplacement.id
  });
  injectUnsafeLegacyRecords(store, {
    active,
    safeSource,
    unsafeDatePublic,
    originalFactId: 'corrected-original'
  });
  store.close();
  return {
    active, other, publicSpace, otherPublic, unsafePublic, activeSubscription,
    unsafeSubscription, originalSource,
    correctionEpisode, hiddenReplacement
  };
}

function injectUnsafeLegacyRecords(store, fixture) {
  const snapshot = store.exportSnapshot();
  const unsafeSourceId = `source-${SECRET}`;
  snapshot.episodes.push({
    id: unsafeSourceId,
    spaceId: fixture.active.id,
    sourceKind: 'conversation',
    body: 'safe source with unsafe id',
    sourceUri: null,
    metadata: {},
    createdAt: '2099-09-01T00:00:00.000Z'
  });
  snapshot.facts.push(factRecord({
    id: 'unsafe-source-id',
    spaceId: fixture.active.id,
    sourceEpisodeId: unsafeSourceId,
    object: 'safe-source-id-item',
    validAt: '2099-09-01T00:00:00.000Z',
    invalidAt: '2099-09-02T00:00:00.000Z',
    status: FactStatus.DEPRECATED
  }));
  snapshot.facts.push(factRecord({
    id: `fact-${SECRET}`,
    spaceId: fixture.active.id,
    sourceEpisodeId: fixture.safeSource.id,
    object: 'unsafe-current-line-marker',
    validAt: '2099-12-01T00:00:00.000Z'
  }));
  snapshot.episodes.push(correctionRecord({
    id: `correction-${SECRET}`,
    spaceId: fixture.active.id,
    factId: fixture.originalFactId,
    action: 'replace'
  }));
  for (let index = 0; index < 100; index += 1) {
    snapshot.facts.push(factRecord({
      id: `oversized-history-${String(index).padStart(3, '0')}`,
      spaceId: fixture.active.id,
      sourceEpisodeId: fixture.safeSource.id,
      object: 'h'.repeat(100 * 1024),
      status: FactStatus.DEPRECATED,
      validAt: new Date(Date.UTC(2200, 0, 1, 0, 0, index)).toISOString(),
      invalidAt: new Date(Date.UTC(2201, 0, 1, 0, 0, index)).toISOString()
    }));
  }
  snapshot.facts.push(factRecord({
    id: 'post-huge-small',
    spaceId: fixture.active.id,
    sourceEpisodeId: fixture.safeSource.id,
    object: 'small after huge history',
    status: FactStatus.DEPRECATED,
    validAt: '2199-01-01T00:00:00.000Z',
    invalidAt: '2199-01-02T00:00:00.000Z'
  }));
  snapshot.episodes.push(correctionRecord({
    id: 'unsafe-correction-action',
    spaceId: fixture.active.id,
    factId: fixture.originalFactId,
    action: SECRET
  }));
  const unsafeDate = snapshot.subscriptions.find(
    ({ spaceId }) => spaceId === fixture.unsafeDatePublic.id
  );
  unsafeDate.createdAt = SECRET;
  store.importSnapshot(snapshot);
}

function factRecord({
  id, spaceId, sourceEpisodeId, object, validAt, invalidAt = null,
  status = FactStatus.CONFIRMED
}) {
  return {
    id, spaceId, sourceEpisodeId, subject: 'user', predicate: 'prefers_test', object,
    status, confidence: 1, sensitivity: Sensitivity.NORMAL, scope: FactScope.PERSONAL,
    validAt, invalidAt, replacedByFactId: null
  };
}

function correctionRecord({ id, spaceId, factId, action }) {
  return {
    id, spaceId, sourceKind: 'correction', body: 'safe correction body', sourceUri: null,
    metadata: { kind: 'lens_correction', factId, action },
    createdAt: '2099-10-01T00:00:00.000Z'
  };
}

function addFact(store, spaceId, sourceEpisodeId, overrides) {
  return store.addFact({
    spaceId,
    sourceEpisodeId,
    subject: 'user',
    predicate: 'prefers_test',
    object: overrides.object,
    scope: FactScope.PERSONAL,
    status: overrides.status ?? FactStatus.CONFIRMED,
    sensitivity: overrides.sensitivity ?? Sensitivity.NORMAL,
    confidence: overrides.confidence ?? 1,
    ...overrides
  });
}

function assertSafeProjection(value, fixture) {
  const serialized = JSON.stringify(value);
  for (const hidden of [
    SECRET, RESTRICTED, SOURCE_BODY, CORRECTION_BODY,
    fixture.other.id, fixture.other.name, fixture.otherPublic.id,
    fixture.hiddenReplacement.id, 'other-personal-value'
  ]) assert.equal(serialized.includes(hidden), false, `leaked ${hidden}`);
  for (const forbidden of ['"snapshot"', '"store"', '"dbPath"', '"path"', '"body"', '"metadata"']) {
    assert.equal(serialized.includes(forbidden), false, `exposed ${forbidden}`);
  }
}
