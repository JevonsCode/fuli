import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';

import { createServer } from '../src/server.js';
import { listenServer } from '../src/server/listen.js';

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

test('listen failure follows borrowed and explicit application ownership', async () => {
  const blocker = createHttpServer();
  await listenServer(blocker, 0);
  const borrowed = trackedApplication();
  const owned = trackedApplication();
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
    assert.equal(borrowed.closeCalls(), 0);
    assert.equal(owned.closeCalls(), 1);
  } finally {
    await closeServer(blocker);
  }
});

test('explicit blocked port is rejected before opening any runtime', async () => {
  const borrowed = trackedApplication();

  await assert.rejects(() => createServer({ app: borrowed.app, port: 6000 }), /blocked/i);

  assert.equal(borrowed.closeCalls(), 0);
});

function trackedApplication() {
  let calls = 0;
  return {
    app: { close: () => { calls += 1; } },
    closeCalls: () => calls
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
