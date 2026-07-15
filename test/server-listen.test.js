import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../src/server.js';
import { listenServer } from '../src/server/listen.js';
import { STORE_METHODS } from '../src/storage/store-port.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { FileStore } from '../src/store.js';

test('listen helper rejects occupied ports and removes temporary listeners', async () => {
  const blocker = createHttpServer();
  await listenServer(blocker, 0);
  const candidate = createHttpServer();
  const baseline = {
    error: candidate.listenerCount('error'),
    listening: candidate.listenerCount('listening')
  };
  try {
    await assert.rejects(() => listenServer(candidate, blocker.address().port), {
      code: 'EADDRINUSE'
    });
    assert.equal(candidate.listenerCount('error'), baseline.error);
    assert.equal(candidate.listenerCount('listening'), baseline.listening);
  } finally {
    await closeServer(blocker);
  }
});

test('listen failure closes an owned SQLite runtime and permits immediate reopen', async () => {
  const blocker = createHttpServer();
  await listenServer(blocker, 0);
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-listen-owned-')), 'context.db');
  try {
    await assert.rejects(() => createServer({ dbPath, port: blocker.address().port }), {
      code: 'EADDRINUSE'
    });
    const store = new SqliteStore(dbPath);
    assert.doesNotThrow(() => store.createSpace('After failure', 'public'));
    store.close();
  } finally {
    await closeServer(blocker);
  }
});

test('listen failure follows borrowed and explicit application ownership', async () => {
  const blocker = createHttpServer();
  await listenServer(blocker, 0);
  const borrowed = trackedApplication();
  const owned = trackedApplication();
  const borrowedStore = trackedStore();
  try {
    await assert.rejects(() => createServer({
      app: borrowed.app,
      port: blocker.address().port
    }), { code: 'EADDRINUSE' });
    await assert.rejects(() => createServer({
      app: owned.app,
      port: blocker.address().port,
      closeApplicationOnShutdown: true
    }), { code: 'EADDRINUSE' });
    await assert.rejects(() => createServer({
      store: borrowedStore.store,
      port: blocker.address().port
    }), { code: 'EADDRINUSE' });
    assert.equal(borrowed.closeCalls(), 0);
    assert.equal(owned.closeCalls(), 1);
    assert.equal(borrowedStore.closeCalls(), 0);
  } finally {
    borrowedStore.store.close();
    await closeServer(blocker);
  }
});

test('explicit blocked port is rejected before opening any runtime', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-blocked-port-')), 'context.db');
  const borrowed = trackedApplication();

  await assert.rejects(() => createServer({ dbPath, port: 6000 }), /blocked/i);
  await assert.rejects(() => createServer({ app: borrowed.app, port: 6000 }), /blocked/i);

  assert.equal(existsSync(dbPath), false);
  assert.equal(borrowed.closeCalls(), 0);
});

function trackedApplication() {
  let calls = 0;
  return {
    app: { close: () => { calls += 1; } },
    closeCalls: () => calls
  };
}

function trackedStore() {
  const backing = new FileStore(':memory:');
  let calls = 0;
  const store = Object.fromEntries(STORE_METHODS.map((method) => [method, (...args) => {
    if (method === 'close') calls += 1;
    return backing[method](...args);
  }]));
  return { store, closeCalls: () => calls };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
