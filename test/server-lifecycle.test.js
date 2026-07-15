import assert from 'node:assert/strict';
import test from 'node:test';

import { createApplication } from '../src/app/create-application.js';
import { createServer, isFetchBlockedPort } from '../src/server.js';
import { FileStore } from '../src/store.js';
import {
  closeServer, expectPortExhaustion, getJson, hideAdapterInternals, overrideStore,
  postJson, trackedApplication
} from '../test-support/server.js';

test('server knows ports that fetch refuses before making a request', () => {
  assert.equal(isFetchBlockedPort(6000), true);
  assert.equal(isFetchBlockedPort(5173), false);
});

test('web API works with a borrowed application and leaves it caller-owned', async () => {
  const store = hideAdapterInternals(new FileStore(':memory:'));
  const app = createApplication({ store });
  let closed = false;
  const close = app.close;
  app.close = () => {
    closed = true;
    return close();
  };
  const { server, url } = await createServer({ app, port: 0 });

  try {
    const bootstrap = await postJson(`${url}/api/bootstrap`, {});
    await postJson(`${url}/api/remember`, {
      personalSpaceId: bootstrap.personal.id,
      targetSpaceId: bootstrap.space.id,
      sourceKind: 'prd',
      body: 'api_base: https://wrapped.example.com'
    });
    const state = await getJson(`${url}/api/state`);
    const search = await getJson(
      `${url}/api/search?personalSpaceId=${bootstrap.personal.id}&q=api_base`
    );

    assert.equal(state.currentFacts.length, 1);
    assert.equal(search.facts[0].object, 'https://wrapped.example.com');
  } finally {
    await closeServer(server);
  }

  assert.equal(closed, false);
  app.close();
  assert.equal(closed, true);
});

test('server leaves an injected store caller-owned', async () => {
  const backingStore = new FileStore(':memory:');
  let closeCalls = 0;
  const store = overrideStore(backingStore, {
    close() {
      closeCalls += 1;
      backingStore.close();
    }
  });
  const { server } = await createServer({ store, port: 0 });

  await closeServer(server);

  assert.equal(closeCalls, 0);
  store.close();
  assert.equal(closeCalls, 1);
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
