import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  ApplicationError,
  ApplicationErrorCode
} from '../src/app/application-error.js';
import { createApplication } from '../src/app/create-application.js';
import { IngestionService } from '../src/ingestion.js';
import { CandidateStatus, SpaceKind } from '../src/models.js';
import { FileStore, SqliteStore } from '../src/store.js';

test('decided candidates reject sequential replays before any write', () => {
  const store = new FileStore(':memory:');
  const app = createApplication({ store });
  const { personal, space } = app.bootstrap();
  const candidate = app.remember({
    personalSpaceId: personal.id,
    targetSpaceId: space.id,
    sourceKind: 'chat',
    body: 'runtime: node-24'
  }).candidate;

  app.decideCandidate(candidate.id, 'sync');
  const decidedSnapshot = store.exportSnapshot();

  for (const replay of ['sync', 'personal_only']) {
    assert.throws(
      () => app.decideCandidate(candidate.id, replay),
      (error) => {
        assert.equal(error instanceof ApplicationError, true);
        assert.equal(error.code, ApplicationErrorCode.VALIDATION);
        return true;
      }
    );
    assert.deepEqual(store.exportSnapshot(), decidedSnapshot);
  }

  assert.equal(store.getCandidate(candidate.id).status, CandidateStatus.SYNCED);
});

test('concurrent SQLite decisions produce one write and one validation loser', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-candidate-race-'));
  const databasePath = join(dir, 'candidates.db');
  let reopened;
  t.after(() => {
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const setup = new SqliteStore(databasePath);
  const personal = setup.createSpace('Me', SpaceKind.PERSONAL);
  const project = setup.createSpace('Project', SpaceKind.PUBLIC);
  const candidate = new IngestionService(setup).remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'chat',
    body: 'runtime: node-24'
  }).candidate;
  setup.close();

  const workerData = {
    databasePath,
    candidateId: candidate.id,
    candidatesUrl: new URL('../src/candidates.js', import.meta.url).href,
    storeUrl: new URL('../src/storage/sqlite-store.js', import.meta.url).href
  };
  const results = await Promise.all([
    decideInWorker(workerData),
    decideInWorker(workerData)
  ]);
  reopened = new SqliteStore(databasePath);

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(
    results.filter((result) => !result.ok).map((result) => result.code),
    [ApplicationErrorCode.VALIDATION]
  );
  assert.equal(reopened.getCandidate(candidate.id).status, CandidateStatus.SYNCED);
  assert.equal(reopened.listEpisodes().length, 2);
  assert.equal(reopened.listFacts({ includeHistorical: true }).length, 1);
  assert.equal(reopened.listPendingOutbox('9999-12-31T23:59:59.999Z').length, 1);
});

function decideInWorker(workerData) {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const [{ decideCandidate }, { SqliteStore }] = await Promise.all([
        import(workerData.candidatesUrl),
        import(workerData.storeUrl)
      ]);
      const store = new SqliteStore(workerData.databasePath);
      try {
        decideCandidate(store, workerData.candidateId, 'sync');
        parentPort.postMessage({ ok: true });
      } catch (error) {
        parentPort.postMessage({ ok: false, code: error.code, message: error.message });
      } finally {
        store.close();
      }
    })().catch((error) => parentPort.postMessage({ ok: false, message: error.stack }));
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData });
    let result;
    worker.once('message', (message) => { result = message; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Candidate worker exited with code ${code}`));
      else resolve(result);
    });
  });
}
