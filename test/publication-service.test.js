import assert from 'node:assert/strict';
import test from 'node:test';

import { PublicationService } from '../src/publication/publication-service.js';
import { contentHash } from '../src/publication/canonical-json.js';
import { FactScope, FactStatus, Sensitivity, SpaceKind } from '../src/models.js';
import { FileStore } from '../src/store.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

test('prepare creates a canonical verifiable envelope and one publication outbox row', () => {
  const { store, space, episode, fact } = fixture();
  const service = new PublicationService(store, { id: () => 'envelope-1' });

  const result = service.prepare({ spaceId: space.id, episode, facts: [fact] });

  assert.equal(result.envelope.id, 'envelope-1');
  assert.equal(result.envelope.spaceId, space.id);
  assert.deepEqual(result.envelope.source, {
    episodeId: episode.id,
    kind: 'prd',
    uri: 'file://project.md',
    capturedAt: episode.createdAt
  });
  assert.deepEqual(result.envelope.facts, [{
    id: fact.id,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    sourceEpisodeId: episode.id
  }]);
  assert.equal(result.envelope.policyVersion, '1');
  assert.match(result.envelope.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(service.verify(result.envelope), true);
  assert.deepEqual(result.outbox.payload, { envelope: result.envelope });
  assert.equal(result.outbox.kind, 'publication');
  assert.equal(result.outbox.aggregateId, `${space.id}:envelope-1`);
  assert.equal(store.listPendingOutbox('9999-12-31T23:59:59.999Z').length, 1);
});

test('prepare rejects empty and duplicate facts before transaction without enqueueing', () => {
  for (const factsFor of [
    () => [],
    (fact) => [fact, fact]
  ]) {
    const { store, space, episode, fact } = fixture();
    const tracked = trackTransactions(store);

    assert.throws(() => new PublicationService(tracked.store).prepare({
      spaceId: space.id,
      episode,
      facts: factsFor(fact)
    }), /fact/i);
    assert.equal(tracked.transactions(), 0);
    assert.equal(store.listPendingOutbox('9999-12-31T23:59:59.999Z').length, 0);
  }
});

for (const [name, createStore] of [
  ['FileStore', () => new FileStore(':memory:')],
  ['SqliteStore', () => new SqliteStore(':memory:')]
]) {
  test(`${name} prepare revalidates authoritative facts inside an immediate transaction`, (t) => {
    const store = createStore();
    t.after(() => store.close());
    const { space, episode, fact } = fixtureIn(store);
    let idCalls = 0;
    let transactionMode;
    const wrapped = hookTransaction(store, {
      before() {
        store.updateFact(fact.id, { status: FactStatus.SUGGESTED });
      },
      onOptions(options) {
        transactionMode = options?.mode;
      }
    });

    assert.throws(() => new PublicationService(wrapped, {
      id: () => {
        idCalls += 1;
        return 'envelope-1';
      }
    }).prepare({ spaceId: space.id, episode, facts: [fact] }), /stored record|confirmed/i);

    assert.equal(transactionMode, 'immediate');
    assert.equal(idCalls, 0);
    assert.equal(store.getFact(fact.id).status, FactStatus.CONFIRMED);
    assert.equal(store.listPendingOutbox('9999-12-31T23:59:59.999Z').length, 0);
  });
}

test('verify is stable across key order and rejects tampering and non-canonical values', () => {
  const { store, space, episode, fact } = fixture();
  const service = new PublicationService(store, { id: () => 'envelope-1' });
  const { envelope } = service.prepare({ spaceId: space.id, episode, facts: [fact] });
  const reordered = {
    contentHash: envelope.contentHash,
    facts: envelope.facts.map((item) => ({
      object: item.object,
      id: item.id,
      sourceEpisodeId: item.sourceEpisodeId,
      predicate: item.predicate,
      subject: item.subject
    })),
    source: {
      capturedAt: envelope.source.capturedAt,
      uri: envelope.source.uri,
      kind: envelope.source.kind,
      episodeId: envelope.source.episodeId
    },
    policyVersion: envelope.policyVersion,
    spaceId: envelope.spaceId,
    id: envelope.id
  };

  assert.equal(service.verify(reordered), true);
  assert.throws(() => service.verify({ ...envelope, spaceId: 'tampered' }), /hash/i);
  assert.throws(() => service.verify({ ...envelope, extra: undefined }), /canonical|JSON|schema/i);
  assert.throws(() => service.verify({ ...envelope, extra: Number.NaN }), /canonical|finite|JSON|schema/i);
  const cyclic = { ...envelope };
  cyclic.extra = cyclic;
  assert.throws(() => service.verify(cyclic), /canonical|circular|JSON|schema/i);
});

test('verify rejects self-signed envelopes outside the exact publication schema', () => {
  const { store, space, episode, fact } = fixture();
  const service = new PublicationService(store, { id: () => 'envelope-1' });
  const { envelope } = service.prepare({ spaceId: space.id, episode, facts: [fact] });
  const invalid = [
    { ...envelope, extra: 'field' },
    without(envelope, 'id'),
    { ...envelope, id: '' },
    { ...envelope, policyVersion: '2' },
    { ...envelope, source: { ...envelope.source, extra: 'field' } },
    { ...envelope, source: without(envelope.source, 'kind') },
    { ...envelope, source: { ...envelope.source, capturedAt: 'yesterday' } },
    { ...envelope, facts: [] },
    { ...envelope, facts: [envelope.facts[0], envelope.facts[0]] },
    { ...envelope, facts: [{ ...envelope.facts[0], extra: 'field' }] },
    { ...envelope, facts: [without(envelope.facts[0], 'predicate')] },
    { ...envelope, facts: [{ ...envelope.facts[0], sourceEpisodeId: 'other-episode' }] }
  ];

  for (const candidate of invalid) {
    assert.throws(() => service.verify(resign(candidate)), /envelope|source|fact|policy|schema/i);
  }
});

test('prepare rejects authentic unsafe records without opening a transaction or enqueueing', () => {
  const cases = [
    ['personal scope', () => fixture({ fact: { scope: FactScope.PERSONAL } })],
    ['private sensitivity', () => fixture({ fact: { sensitivity: Sensitivity.PRIVATE } })],
    ['restricted sensitivity', () => fixture({ fact: { sensitivity: Sensitivity.RESTRICTED } })],
    ['unconfirmed fact', () => fixture({ fact: { status: FactStatus.SUGGESTED } })],
    ['missing source', () => fixture({ fact: { sourceEpisodeId: 'missing' } })],
    ['secret fact', () => fixture({ fact: { object: 'api_key: sk-abcdefghijklmnop' } })],
    ['secret source metadata', () => fixture({
      metadata: { token: 'api_key: sk-abcdefghijklmnop' }
    })]
  ];

  for (const [name, create] of cases) {
    const base = create();
    const tracked = trackTransactions(base.store);
    const service = new PublicationService(tracked.store);
    assert.throws(
      () => service.prepare({
        spaceId: base.space.id,
        episode: base.episode,
        facts: [base.fact]
      }),
      undefined,
      name
    );
    assert.equal(tracked.transactions(), 0, name);
    assert.equal(base.store.listPendingOutbox('9999-12-31T23:59:59.999Z').length, 0, name);
  }
});

test('prepare rejects a stored source body containing a secret before transaction', () => {
  const base = fixture({ body: 'api_key: sk-abcdefghijklmnop' });
  const tracked = trackTransactions(base.store);

  assert.throws(() => new PublicationService(tracked.store).prepare({
    spaceId: base.space.id,
    episode: base.episode,
    facts: [base.fact]
  }), /secret/i);
  assert.equal(tracked.transactions(), 0);
  assert.equal(base.store.listPendingOutbox('9999-12-31T23:59:59.999Z').length, 0);
});

test('prepare rejects a forged episode before opening a transaction', () => {
  const { store, space, episode, fact } = fixture();
  const tracked = trackTransactions(store);
  assert.throws(() => new PublicationService(tracked.store).prepare({
    spaceId: space.id,
    episode: { ...episode, sourceUri: 'file://forged' },
    facts: [fact]
  }), /stored record/i);
  assert.equal(tracked.transactions(), 0);
});

test('prepare rejects non-public and cross-space records before transaction', () => {
  const { store, space, episode, fact } = fixture();
  const personal = store.createSpace('Private', SpaceKind.PERSONAL);
  const other = store.createSpace('Other', SpaceKind.PUBLIC);
  const tracked = trackTransactions(store);
  const service = new PublicationService(tracked.store);

  assert.throws(() => service.prepare({ spaceId: personal.id, episode, facts: [fact] }), /public/i);
  assert.throws(() => service.prepare({ spaceId: other.id, episode, facts: [fact] }), /space/i);
  assert.equal(tracked.transactions(), 0);
});

function fixture({
  fact: factOverrides = {},
  metadata = { localPath: 'T:/private/project.md' },
  body = 'runtime: node-24'
} = {}) {
  const store = new FileStore(':memory:');
  return { store, ...fixtureIn(store, { fact: factOverrides, metadata, body }) };
}

function fixtureIn(store, {
  fact: factOverrides = {},
  metadata = { localPath: 'T:/private/project.md' },
  body = 'runtime: node-24'
} = {}) {
  const space = store.createSpace('Project A', SpaceKind.PUBLIC);
  const episode = store.addEpisode(
    space.id,
    'prd',
    body,
    'file://project.md',
    metadata
  );
  const fact = store.addFact({
    spaceId: space.id,
    subject: 'Project A',
    predicate: 'has_runtime',
    object: 'node-24',
    sourceEpisodeId: episode.id,
    status: FactStatus.CONFIRMED,
    sensitivity: Sensitivity.NORMAL,
    scope: FactScope.PUBLIC,
    ...factOverrides
  });
  return { space, episode, fact };
}

function resign(envelope) {
  const { contentHash: _oldHash, ...unsigned } = envelope;
  return { ...unsigned, contentHash: contentHash(unsigned) };
}

function without(value, key) {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));
}

function trackTransactions(store) {
  let count = 0;
  return {
    store: new Proxy(store, {
      get(target, property) {
        if (property === 'transaction') {
          return (...args) => {
            count += 1;
            return target.transaction(...args);
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }),
    transactions: () => count
  };
}

function hookTransaction(store, { before, onOptions }) {
  let proxy;
  proxy = new Proxy(store, {
    get(target, property) {
      if (property === 'transaction') {
        return (fn, options) => {
          onOptions(options);
          return target.transaction(() => {
            before();
            return fn(proxy);
          }, options);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return proxy;
}
