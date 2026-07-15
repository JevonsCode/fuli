import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError, ApplicationErrorCode } from '../src/app/application-error.js';
import { IngestionService } from '../src/ingestion.js';
import { LensService } from '../src/lens/lens-service.js';
import { SpaceKind } from '../src/models.js';
import { STORE_METHODS } from '../src/storage/store-port.js';
import { FileStore } from '../src/store.js';

const SECRET = 'glpat-abcdefghijklmnopqrst';
const PERSISTED_COLLECTIONS = ['episodes', 'facts', 'candidates', 'outbox'];

test('ingestion rejects secret source metadata before transactions or writes', () => {
  const base = new FileStore(':memory:');
  const personal = base.createSpace('Me', SpaceKind.PERSONAL);
  const project = base.createSpace('Project', SpaceKind.PUBLIC);
  const legacy = base.addEpisode(personal.id, 'chat', 'runtime: node', `chat://${SECRET}`);
  const tracked = trackTransactions(base);
  const ingestion = new IngestionService(tracked.store);
  const before = base.exportSnapshot();

  const attempts = [
    () => ingestion.remember({
      personalSpaceId: personal.id,
      sourceKind: 'personal',
      sourceUri: `personal://${SECRET}`,
      body: 'local_alias: pnpm dev'
    }),
    () => ingestion.remember({
      personalSpaceId: personal.id,
      targetSpaceId: project.id,
      sourceKind: SECRET,
      body: 'Maybe split this module later'
    }),
    () => ingestion.remember({
      personalSpaceId: personal.id,
      targetSpaceId: project.id,
      sourceKind: 'prd',
      sourceUri: `prd://${SECRET}`,
      body: 'runtime: node-24'
    }),
    () => ingestion.publishConfirmed({
      targetSpaceId: project.id,
      sourceKind: SECRET,
      body: 'runtime: node-24'
    }),
    () => ingestion.confirmEpisode({ personalSpaceId: personal.id, spaceId: personal.id, episode: legacy })
  ];

  for (const attempt of attempts) {
    assertSecretRejected(attempt, base, before);
  }
  assert.equal(tracked.transactions(), 0);
});

test('Personal Lens rejects secret source metadata before transactions or writes', () => {
  const base = new FileStore(':memory:');
  const personal = base.createSpace('Me', SpaceKind.PERSONAL);
  const setupLens = new LensService(base);
  const observed = setupLens.submitUserObservation({
    personalSpaceId: personal.id,
    predicate: 'prefers_small_modules',
    value: 'true',
    evidenceText: 'Repeatedly requested small modules',
    inference: 'inferred'
  });
  const confirmed = setupLens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: 'Prefers JavaScript'
  });
  const legacy = base.addEpisode(personal.id, 'legacy', 'prefers tests', `legacy://${SECRET}`);
  const tracked = trackTransactions(base);
  const lens = new LensService(tracked.store);
  const before = base.exportSnapshot();
  const specs = [{ subject: 'user', predicate: 'prefers_tests', object: 'true' }];

  const attempts = [
    () => lens.rememberUserFact({
      personalSpaceId: personal.id, predicate: 'prefers_tests', value: 'true',
      sourceText: 'Prefers tests', sourceKind: SECRET
    }),
    () => lens.submitUserObservation({
      personalSpaceId: personal.id, predicate: 'prefers_tests', value: 'true',
      evidenceText: 'Repeatedly requested tests', inference: 'direct', sourceKind: SECRET
    }),
    () => lens.confirmObservation({
      personalSpaceId: personal.id, factId: observed.fact.id,
      sourceText: 'Confirmed small modules', sourceKind: SECRET
    }),
    () => lens.correctUserFact({
      personalSpaceId: personal.id, factId: confirmed.fact.id, action: 'replace',
      value: 'TypeScript', sourceText: 'Corrected language', sourceKind: SECRET
    }),
    () => lens.rememberUserFactsFromSourceInCurrentTransaction({
      personalSpaceId: personal.id, specs, sourceText: 'Prefers tests',
      sourceKind: 'conversation', sourceUri: `conversation://${SECRET}`
    }),
    () => lens.writeUserFactsForEpisodeInCurrentTransaction({
      personalSpaceId: personal.id, specs, episode: legacy
    })
  ];

  for (const attempt of attempts) {
    assertSecretRejected(attempt, base, before);
  }
  assert.equal(tracked.transactions(), 0);
});

function assertSecretRejected(action, store, before) {
  let error;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  assert.equal(error instanceof ApplicationError, true);
  assert.equal(error.code, ApplicationErrorCode.VALIDATION);
  assert.equal(error.message.includes(SECRET), false);
  const after = store.exportSnapshot();
  for (const collection of PERSISTED_COLLECTIONS) {
    assert.deepEqual(after[collection], before[collection], `${collection} changed`);
  }
}

function trackTransactions(base) {
  let count = 0;
  const store = Object.fromEntries(STORE_METHODS.map((method) => [
    method,
    method === 'transaction'
      ? (...args) => { count += 1; return base.transaction(...args); }
      : (...args) => base[method](...args)
  ]));
  return { store, transactions: () => count };
}
