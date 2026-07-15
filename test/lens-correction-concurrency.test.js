import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { ApplicationErrorCode } from '../src/app/application-error.js';
import { LensService } from '../src/lens/lens-service.js';
import { FactStatus, SpaceKind } from '../src/models.js';
import { SqliteStore } from '../src/store.js';
import { STORE_METHODS } from '../src/storage/store-port.js';

test('concurrent SQLite corrections produce one replacement and one validation loser', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-correction-race-'));
  const databasePath = join(dir, 'lens.db');
  let reopened;
  t.after(() => {
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const setup = new SqliteStore(databasePath);
  const personal = setup.createSpace('我', SpaceKind.PERSONAL);
  const original = new LensService(setup).rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '我熟悉 JavaScript'
  });
  setup.close();

  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workerData = {
    databasePath,
    personalSpaceId: personal.id,
    factId: original.fact.id,
    barrier,
    lensUrl: new URL('../src/lens/lens-service.js', import.meta.url).href,
    storeUrl: new URL('../src/storage/sqlite-store.js', import.meta.url).href,
    portUrl: new URL('../src/storage/store-port.js', import.meta.url).href
  };
  const results = await Promise.all([
    correctInWorker({ ...workerData, value: 'TypeScript', sourceText: '现在更偏好 TypeScript' }),
    correctInWorker({ ...workerData, value: 'Python', sourceText: '现在更偏好 Python' })
  ]);
  reopened = new SqliteStore(databasePath);

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(
    results.filter((result) => !result.ok).map((result) => result.code),
    [ApplicationErrorCode.VALIDATION]
  );
  assert.equal(reopened.listEpisodes().length, 2);
  assert.equal(reopened.listFacts({ includeHistorical: true }).length, 2);
  assert.equal(reopened.currentFacts(personal.id).length, 1);
  assert.equal(reopened.currentFacts(personal.id)[0].status, FactStatus.CONFIRMED);
});

function correctInWorker(workerData) {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const [{ LensService }, { SqliteStore }, { STORE_METHODS }] = await Promise.all([
        import(workerData.lensUrl),
        import(workerData.storeUrl),
        import(workerData.portUrl)
      ]);
      const store = new SqliteStore(workerData.databasePath);
      let transactionActive = false;
      const wrapped = Object.fromEntries(STORE_METHODS.map((method) => [method, (...args) => {
        if (method === 'transaction') {
          const [fn, options] = args;
          return store.transaction(() => {
            transactionActive = true;
            try { return fn(wrapped); } finally { transactionActive = false; }
          }, options);
        }
        const result = store[method](...args);
        if (method === 'getFact' && !transactionActive) {
          const state = new Int32Array(workerData.barrier);
          const arrived = Atomics.add(state, 0, 1) + 1;
          Atomics.notify(state, 0);
          while (arrived < 2 && Atomics.load(state, 0) < 2) Atomics.wait(state, 0, 1, 1000);
        }
        return result;
      }]));
      try {
        const result = new LensService(wrapped).correctUserFact({
          personalSpaceId: workerData.personalSpaceId,
          factId: workerData.factId,
          action: 'replace',
          value: workerData.value,
          sourceText: workerData.sourceText
        });
        parentPort.postMessage({ ok: true, factId: result.fact.id });
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
      if (code !== 0) reject(new Error(`Correction worker exited with code ${code}`));
      else resolve(result);
    });
  });
}
