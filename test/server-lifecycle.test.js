import assert from 'node:assert/strict';
import test from 'node:test';

import { createServer, isFetchBlockedPort } from '../src/server.js';
import {
  closeServer, expectPortExhaustion, trackedApplication
} from '../test-support/server.js';

test('server knows ports that fetch refuses before making a request', () => {
  assert.equal(isFetchBlockedPort(6000), true);
  assert.equal(isFetchBlockedPort(2727), false);
});

test('server closes an injected application only with explicit ownership', async () => {
  const tracked = trackedApplication();
  const { server } = await createServer({
    app: tracked.app,
    port: 0,
    closeApplicationOnShutdown: true
  });

  await closeServer(server);

  assert.equal(tracked.closeCalls(), 1);
});

test('blocked-port exhaustion follows borrowed and owned application lifecycles', async () => {
  const borrowed = trackedApplication();
  await assert.rejects(
    () => expectPortExhaustion({ app: borrowed.app, port: 0, isBlockedPort: () => true }),
    /Could not find a fetchable local port/
  );
  assert.equal(borrowed.closeCalls(), 0);
  borrowed.app.close();

  const owned = trackedApplication();
  await assert.rejects(
    () => expectPortExhaustion({
      app: owned.app,
      port: 0,
      isBlockedPort: () => true,
      closeApplicationOnShutdown: true
    }),
    /Could not find a fetchable local port/
  );
  assert.equal(owned.closeCalls(), 1);
});
