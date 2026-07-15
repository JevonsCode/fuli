import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CandidateStatus, FactStatus, SpaceKind } from '../src/models.js';
import { assertStorePort } from '../src/storage/store-port.js';

const FIRST_INSTANT = '2026-07-10T00:00:00.000Z';
const SECOND_INSTANT = '2026-07-10T00:01:00.000Z';

export function runStoreContract(name, createStore) {
  describe(`${name} Store Port contract`, () => {
    const storeTest = (title, fn) => test(title, (t) => {
      const store = createStore();
      t.after(() => store.close());
      return fn(store);
    });

    storeTest('implements every Store Port method and closes idempotently', (store) => {
      assert.equal(assertStorePort(store), store);
      assert.doesNotThrow(() => {
        store.close();
        store.close();
      });
    });

    storeTest('stores detached spaces and returns an existing duplicate name', (store) => {
      const personal = store.createSpace('Jevons', SpaceKind.PERSONAL, 'Private context');
      const duplicate = store.createSpace('Jevons', SpaceKind.PUBLIC, 'Ignored');

      assert.deepEqual(duplicate, personal);
      personal.name = 'Changed by caller';
      const listed = store.listSpaces();
      listed[0].description = 'Changed through list';
      listed.push({ id: 'external' });

      assert.equal(store.findSpaceByName('Jevons').name, 'Jevons');
      assert.equal(store.getSpace(duplicate.id).description, 'Private context');
      assert.equal(store.listSpaces().length, 1);
      assert.equal(store.getSpace('missing'), null);
    });

    storeTest('stores subscriptions with defaults, uniqueness, and detachment', (store) => {
      const { personal, project } = createSpaces(store);
      const subscription = store.subscribe(personal.id, project.id);
      const duplicate = store.subscribe(personal.id, project.id, 'preview');

      assert.equal(subscription.mode, 'latest');
      assert.match(subscription.createdAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(duplicate, subscription);

      const listed = store.listSubscriptions();
      listed[0].mode = 'changed';
      assert.deepEqual(store.subscriptionsFor(personal.id), [subscription]);
    });

    storeTest('stores episode metadata with a detached empty-object default', (store) => {
      const { project } = createSpaces(store);
      const defaultEpisode = store.addEpisode(project.id, 'prd', 'runtime: node');
      const metadata = { parser: { version: 1 } };
      const richEpisode = store.addEpisode(
        project.id,
        'commit',
        'upgrade runtime',
        'git://commit/1',
        metadata
      );

      assert.deepEqual(defaultEpisode.metadata, {});
      assert.deepEqual(richEpisode.metadata, metadata);
      metadata.parser.version = 2;
      richEpisode.metadata.parser.version = 3;
      assert.equal(store.getEpisode(richEpisode.id).metadata.parser.version, 1);

      const listed = store.listEpisodes();
      listed[1].metadata.parser.version = 4;
      assert.equal(store.getEpisode(richEpisode.id).metadata.parser.version, 1);
      assert.equal(store.getEpisode('missing'), null);
    });

    storeTest('supports fact defaults, updates, history, search, and invalidation', (store) => {
      const { project } = createSpaces(store);
      const episode = store.addEpisode(project.id, 'prd', 'runtime changed');
      const oldFact = store.addFact({
        spaceId: project.id,
        subject: 'Project A',
        predicate: 'has_runtime',
        object: 'Node.js 22',
        sourceEpisodeId: episode.id,
        validAt: FIRST_INSTANT
      });
      const replacement = store.addFact({
        spaceId: project.id,
        subject: 'Project A',
        predicate: 'has_runtime',
        object: 'Node.js 24',
        sourceEpisodeId: episode.id,
        status: FactStatus.OBSERVED,
        confidence: 0.75,
        sensitivity: 'private',
        scope: 'public',
        validAt: SECOND_INSTANT
      });

      assert.equal(oldFact.status, FactStatus.CONFIRMED);
      assert.equal(oldFact.confidence, 1);
      assert.equal(oldFact.sensitivity, 'normal');
      assert.equal(oldFact.scope, 'personal');

      const updated = store.updateFact(replacement.id, {
        status: FactStatus.CONFIRMED,
        confidence: 0.9,
        object: 'Node.js 24 LTS'
      });
      assert.equal(updated.status, FactStatus.CONFIRMED);
      assert.equal(updated.confidence, 0.9);
      assert.throws(
        () => store.updateFact('missing', { object: 'none' }),
        /Fact not found: missing/
      );

      store.invalidateFact(oldFact.id, replacement.id);
      const invalidated = store.getFact(oldFact.id);
      assert.match(invalidated.invalidAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(invalidated.replacedByFactId, replacement.id);
      assert.doesNotThrow(() => store.invalidateFact(oldFact.id));
      assert.doesNotThrow(() => store.invalidateFact('missing'));

      assert.deepEqual(store.currentFacts(project.id), [updated]);
      assert.deepEqual(store.listFacts(), [updated]);
      assert.deepEqual(store.timeline(project.id, 'Project A'), [invalidated, updated]);
      assert.deepEqual(store.searchFacts([project.id], '24 lts'), [updated]);
      assert.deepEqual(store.searchFacts([project.id], '22'), []);
      assert.deepEqual(
        store.searchFacts([project.id], '22', { includeHistorical: true }),
        [invalidated]
      );
      assert.equal(store.searchFacts([], 'node').length, 0);
    });

    storeTest('treats rejected and deprecated facts without invalidAt as historical', (store) => {
      const { project } = createSpaces(store);
      const episode = store.addEpisode(project.id, 'legacy', 'legacy status records');
      const confirmed = store.addFact({
        id: 'fact-current',
        spaceId: project.id,
        subject: 'Project A',
        predicate: 'has_state',
        object: 'current',
        sourceEpisodeId: episode.id,
        status: FactStatus.CONFIRMED
      });
      const rejected = store.addFact({
        id: 'fact-rejected',
        spaceId: project.id,
        subject: 'Project A',
        predicate: 'has_state',
        object: 'rejected legacy',
        sourceEpisodeId: episode.id,
        status: FactStatus.REJECTED
      });
      const deprecated = store.addFact({
        id: 'fact-deprecated',
        spaceId: project.id,
        subject: 'Project A',
        predicate: 'has_state',
        object: 'deprecated legacy',
        sourceEpisodeId: episode.id,
        status: FactStatus.DEPRECATED
      });

      assert.deepEqual(store.currentFacts(project.id), [confirmed]);
      assert.deepEqual(store.listFacts(), [confirmed]);
      assert.deepEqual(store.searchFacts([project.id], 'legacy'), []);
      assert.deepEqual(
        store.listFacts({ includeHistorical: true }),
        [confirmed, rejected, deprecated]
      );
    });

    storeTest('rejects duplicate fact ids before mutation and detaches returned facts', (store) => {
      const { project } = createSpaces(store);
      const episode = store.addEpisode(project.id, 'prd', 'runtime: node');
      const input = {
        id: 'fact-duplicate',
        spaceId: project.id,
        subject: 'Project A',
        predicate: 'has_runtime',
        object: 'node',
        sourceEpisodeId: episode.id
      };
      const fact = store.addFact(input);
      const before = store.exportSnapshot();

      assert.throws(
        () => store.addFact({ ...input, object: 'python' }),
        /Duplicate fact id: fact-duplicate/
      );
      assert.deepEqual(store.exportSnapshot(), before);

      fact.object = 'changed';
      const listed = store.listFacts();
      listed[0].object = 'changed again';
      assert.equal(store.getFact(fact.id).object, 'node');
      assert.equal(store.getFact('missing'), null);
    });

    storeTest('rejects invalid fact records and updates before mutation', (store) => {
      const { project } = createSpaces(store);
      const episode = store.addEpisode(project.id, 'prd', 'runtime: node');
      const baseFact = {
        spaceId: project.id,
        subject: 'Project A',
        predicate: 'has_runtime',
        object: 'node',
        sourceEpisodeId: episode.id
      };
      const invalidRecords = [
        [{ ...baseFact, status: 'invented' }, /Invalid fact status: invented/],
        [{ ...baseFact, confidence: -0.01 }, /confidence must be between 0 and 1/i],
        [{ ...baseFact, confidence: 1.01 }, /confidence must be between 0 and 1/i],
        [{ ...baseFact, sensitivity: 'secret' }, /Invalid fact sensitivity: secret/],
        [{ ...baseFact, scope: 'team' }, /Invalid fact scope: team/]
      ];

      for (const [record, errorPattern] of invalidRecords) {
        assertRejectedWithoutMutation(store, () => store.addFact(record), errorPattern);
      }

      const fact = store.addFact(baseFact);
      assertRejectedWithoutMutation(
        store,
        () => store.updateFact(fact.id, { confidence: Number.NaN }),
        /confidence must be between 0 and 1/i
      );
    });

    storeTest('supports candidate decisions, duplicate protection, and detachment', (store) => {
      const { personal, project } = createSpaces(store);
      const episode = store.addEpisode(project.id, 'chat', 'possible shared fact');
      const input = {
        id: 'candidate-1',
        personalSpaceId: personal.id,
        targetSpaceId: project.id,
        episodeId: episode.id,
        reason: 'needs review'
      };
      const candidate = store.addCandidate(input);
      const beforeDuplicate = store.exportSnapshot();

      assert.equal(candidate.status, CandidateStatus.PENDING);
      assert.equal(candidate.decidedAt, null);
      assert.deepEqual(store.pendingCandidates(personal.id), [candidate]);
      assert.throws(
        () => store.addCandidate({ ...input, reason: 'changed' }),
        /Duplicate candidate id: candidate-1/
      );
      assert.deepEqual(store.exportSnapshot(), beforeDuplicate);

      const decided = store.updateCandidateStatus(candidate.id, CandidateStatus.IGNORED);
      assert.equal(decided.status, CandidateStatus.IGNORED);
      assert.match(decided.decidedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(store.pendingCandidates(personal.id), []);
      assert.throws(
        () => store.updateCandidateStatus('missing', CandidateStatus.IGNORED),
        /Candidate not found: missing/
      );

      decided.reason = 'changed';
      const listed = store.listCandidates();
      listed[0].reason = 'changed through list';
      assert.equal(store.getCandidate(candidate.id).reason, 'needs review');
      assert.equal(store.getCandidate('missing'), null);
    });

    storeTest('rejects invalid candidate statuses before mutation', (store) => {
      const { personal, project } = createSpaces(store);
      const episode = store.addEpisode(project.id, 'chat', 'possible shared fact');
      const candidateInput = {
        personalSpaceId: personal.id,
        targetSpaceId: project.id,
        episodeId: episode.id,
        reason: 'needs review'
      };

      assertRejectedWithoutMutation(
        store,
        () => store.addCandidate({ ...candidateInput, status: 'approved' }),
        /Invalid candidate status: approved/
      );

      const candidate = store.addCandidate(candidateInput);
      assertRejectedWithoutMutation(
        store,
        () => store.updateCandidateStatus(candidate.id, 'approved'),
        /Invalid candidate status: approved/
      );
    });

    storeTest('supports detached Outbox transitions and duplicate protection', (store) => {
      const input = {
        id: 'outbox-1',
        kind: 'publication',
        aggregateId: 'project-1',
        payload: { envelope: { version: 1 } },
        createdAt: FIRST_INSTANT
      };
      const row = store.enqueueOutbox(input);
      input.payload.envelope.version = 2;
      row.payload.envelope.version = 3;
      assert.equal(store.listPendingOutbox(SECOND_INSTANT)[0].payload.envelope.version, 1);

      const beforeDuplicate = store.exportSnapshot();
      assert.throws(
        () => store.enqueueOutbox({ ...input, payload: { changed: true } }),
        /Duplicate outbox id: outbox-1/
      );
      assert.deepEqual(store.exportSnapshot(), beforeDuplicate);

      const failed = store.markOutboxFailed('outbox-1', 'offline', SECOND_INSTANT);
      assert.equal(failed.attempts, 1);
      assert.equal(failed.lastError, 'offline');
      assert.deepEqual(store.listPendingOutbox(FIRST_INSTANT), []);
      assert.deepEqual(store.listPendingOutbox(SECOND_INSTANT), [failed]);

      const sent = store.markOutboxSent('outbox-1', '2026-07-10T00:02:00.000Z');
      assert.equal(sent.status, 'sent');
      assert.equal(sent.nextAttemptAt, null);
      assert.equal(sent.lastError, null);
      assert.deepEqual(store.listPendingOutbox('2026-07-10T00:03:00.000Z'), []);
      assert.throws(() => store.markOutboxFailed('missing', 'offline'), /Outbox row not found/);
      assert.throws(() => store.markOutboxSent('missing'), /Outbox row not found/);
    });

    storeTest('rejects invalid Outbox status and attempts before mutation', (store) => {
      const baseEntry = {
        kind: 'publication',
        aggregateId: 'project-1',
        payload: {}
      };
      const invalidRecords = [
        [{ ...baseEntry, status: 'failed' }, /Invalid outbox status: failed/],
        [{ ...baseEntry, attempts: -1 }, /attempts must be a nonnegative integer/i],
        [{ ...baseEntry, attempts: 1.5 }, /attempts must be a nonnegative integer/i]
      ];

      for (const [record, errorPattern] of invalidRecords) {
        assertRejectedWithoutMutation(store, () => store.enqueueOutbox(record), errorPattern);
      }
    });

    storeTest('tracks imports and rejects duplicate hashes before mutation', (store) => {
      const record = {
        contentHash: 'content-hash',
        sourcePath: 'legacy.json',
        importedAt: FIRST_INSTANT
      };

      assert.equal(store.hasImport(record.contentHash), false);
      const stored = store.recordImport(record);
      stored.sourcePath = 'changed';
      assert.equal(store.hasImport(record.contentHash), true);
      const before = store.exportSnapshot();
      assert.throws(
        () => store.recordImport({ ...record, sourcePath: 'other.json' }),
        /Duplicate import content hash: content-hash/
      );
      assert.deepEqual(store.exportSnapshot(), before);
    });

    storeTest('imports legacy snapshots with defaults and preserves omitted durable queues', (store) => {
      const pending = store.enqueueOutbox({
        id: 'preserved-outbox',
        kind: 'publication',
        aggregateId: 'project-old',
        payload: { value: 'keep' },
        createdAt: FIRST_INSTANT
      });
      const imported = store.recordImport({
        contentHash: 'preserved-hash',
        sourcePath: 'old.json',
        importedAt: FIRST_INSTANT
      });
      const legacy = legacySnapshot();

      store.importSnapshot(legacy);
      legacy.spaces[0].name = 'Changed by caller';

      const snapshot = store.exportSnapshot();
      assert.equal(store.getSpace('personal-1').name, 'Personal');
      assert.match(snapshot.subscriptions[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(snapshot.episodes[0].metadata, {});
      assert.equal(snapshot.facts[0].confidence, 1);
      assert.equal(snapshot.facts[0].sensitivity, 'normal');
      assert.equal(snapshot.facts[0].scope, 'personal');
      assert.equal(snapshot.candidates[0].decidedAt, null);
      assert.deepEqual(snapshot.outbox, [pending]);
      assert.deepEqual(snapshot.imports, [imported]);

      snapshot.episodes[0].metadata.external = true;
      assert.deepEqual(store.getEpisode('episode-1').metadata, {});
    });

    storeTest('restores explicitly supplied Outbox and import records', (store) => {
      store.enqueueOutbox({
        id: 'old-outbox',
        kind: 'publication',
        aggregateId: 'old',
        payload: {},
        createdAt: FIRST_INSTANT
      });
      store.recordImport({
        contentHash: 'old-hash',
        sourcePath: 'old.json',
        importedAt: FIRST_INSTANT
      });
      const explicitOutbox = [{
        id: 'restored-outbox',
        kind: 'publication',
        aggregateId: 'restored',
        payload: { restored: true },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: null,
        createdAt: FIRST_INSTANT,
        sentAt: null,
        lastError: null
      }];
      const explicitImports = [{
        contentHash: 'restored-hash',
        sourcePath: 'restored.json',
        importedAt: FIRST_INSTANT
      }];

      store.importSnapshot({
        ...legacySnapshot(),
        outbox: explicitOutbox,
        imports: explicitImports
      });

      assert.deepEqual(store.exportSnapshot().outbox, explicitOutbox);
      assert.deepEqual(store.exportSnapshot().imports, explicitImports);
      assert.equal(store.hasImport('old-hash'), false);
    });

    storeTest('imports fact replacement links independently of fact array order', (store) => {
      const snapshot = legacySnapshot();
      snapshot.facts = [{
        id: 'fact-old',
        spaceId: 'project-1',
        subject: 'Project A',
        predicate: 'has_runtime',
        object: 'node-22',
        sourceEpisodeId: 'episode-1',
        status: FactStatus.CONFIRMED,
        validAt: FIRST_INSTANT,
        invalidAt: SECOND_INSTANT,
        replacedByFactId: 'fact-new'
      }, {
        id: 'fact-new',
        spaceId: 'project-1',
        subject: 'Project A',
        predicate: 'has_runtime',
        object: 'node-24',
        sourceEpisodeId: 'episode-1',
        status: FactStatus.CONFIRMED,
        validAt: SECOND_INSTANT,
        invalidAt: null,
        replacedByFactId: null
      }];

      store.importSnapshot(snapshot);

      assert.equal(store.getFact('fact-old').replacedByFactId, 'fact-new');
      assert.deepEqual(store.currentFacts('project-1'), [store.getFact('fact-new')]);
    });

    storeTest('rejects invalid snapshot records before replacing current data', (store) => {
      createSpaces(store);
      const invalidSnapshot = legacySnapshot();
      invalidSnapshot.facts[0].scope = 'team';

      assertRejectedWithoutMutation(
        store,
        () => store.importSnapshot(invalidSnapshot),
        /Invalid fact scope: team/
      );
    });

    storeTest('exports snapshots as detached domain data', (store) => {
      const { project } = createSpaces(store);
      const episode = store.addEpisode(project.id, 'prd', 'runtime: node', null, {
        nested: { value: 1 }
      });
      const snapshot = store.exportSnapshot();

      snapshot.spaces[0].name = 'Changed';
      snapshot.episodes[0].metadata.nested.value = 2;
      snapshot.spaces.push({ id: 'external' });

      assert.equal(store.getSpace(project.id).name, 'Project A');
      assert.equal(store.getEpisode(episode.id).metadata.nested.value, 1);
      assert.equal(store.listSpaces().length, 2);
    });

    storeTest('rolls back all mutations when a synchronous transaction fails', (store) => {
      createSpaces(store);
      const before = store.exportSnapshot();
      const failure = new Error('stop transaction');

      assert.throws(() => store.transaction((transactionStore) => {
        assert.equal(transactionStore, store);
        transactionStore.createSpace('Transient', SpaceKind.PUBLIC);
        transactionStore.enqueueOutbox({
          kind: 'publication',
          aggregateId: 'transient',
          payload: {}
        });
        throw failure;
      }), failure);

      assert.deepEqual(store.exportSnapshot(), before);
    });

    storeTest('rejects async, thenable, and nested transactions with rollback', (store) => {
      createSpaces(store);
      const before = store.exportSnapshot();
      let asyncCalled = false;

      assert.throws(() => store.transaction(async () => {
        asyncCalled = true;
      }), /transaction callback must be synchronous/i);
      assert.equal(asyncCalled, false);

      assert.throws(() => store.transaction((transactionStore) => {
        transactionStore.createSpace('Thenable', SpaceKind.PUBLIC);
        return { then() {}, catch() {} };
      }), /transaction callback must be synchronous/i);
      assert.deepEqual(store.exportSnapshot(), before);

      let nestedCalled = false;
      assert.throws(() => store.transaction((outerStore) => {
        outerStore.createSpace('Outer', SpaceKind.PUBLIC);
        assert.throws(() => outerStore.transaction(() => {
          nestedCalled = true;
        }), /nested .* transactions are not supported/i);
        throw new Error('rollback outer');
      }), /rollback outer/);
      assert.equal(nestedCalled, false);
      assert.deepEqual(store.exportSnapshot(), before);
    });
  });
}

function createSpaces(store) {
  return {
    personal: store.createSpace('Personal', SpaceKind.PERSONAL),
    project: store.createSpace('Project A', SpaceKind.PUBLIC)
  };
}

function legacySnapshot() {
  return {
    spaces: [{
      id: 'personal-1',
      name: 'Personal',
      kind: SpaceKind.PERSONAL,
      description: null,
      createdAt: FIRST_INSTANT
    }, {
      id: 'project-1',
      name: 'Project A',
      kind: SpaceKind.PUBLIC,
      description: null,
      createdAt: FIRST_INSTANT
    }],
    subscriptions: [{
      personalSpaceId: 'personal-1',
      spaceId: 'project-1',
      mode: 'latest'
    }],
    episodes: [{
      id: 'episode-1',
      spaceId: 'project-1',
      sourceKind: 'prd',
      body: 'runtime: node',
      sourceUri: null,
      createdAt: FIRST_INSTANT
    }],
    facts: [{
      id: 'fact-1',
      spaceId: 'project-1',
      subject: 'Project A',
      predicate: 'has_runtime',
      object: 'node',
      sourceEpisodeId: 'episode-1',
      status: FactStatus.CONFIRMED,
      validAt: FIRST_INSTANT,
      invalidAt: null,
      replacedByFactId: null
    }],
    candidates: [{
      id: 'candidate-1',
      personalSpaceId: 'personal-1',
      targetSpaceId: 'project-1',
      episodeId: 'episode-1',
      reason: 'needs review',
      status: CandidateStatus.PENDING,
      createdAt: FIRST_INSTANT
    }]
  };
}

function assertRejectedWithoutMutation(store, action, errorPattern) {
  const before = store.exportSnapshot();
  assert.throws(action, errorPattern);
  assert.deepEqual(store.exportSnapshot(), before);
}
