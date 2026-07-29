import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

test('local console health identifies the service and owning process without querying Providers',
  async () => {
    let stateCalled = false;
    const runtime = await createServer({
      port: 0,
      app: {
        graphiti: true,
        async state() {
          stateCalled = true;
          throw new Error('Provider state must not be queried by the process identity endpoint');
        },
        close() {}
      }
    });

    try {
      const response = await fetch(`${runtime.url}/api/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        status: 'ready',
        service: 'fuli-local-console',
        pid: process.pid
      });
      assert.equal(stateCalled, false);
    } finally {
      await new Promise((resolve) => runtime.server.close(resolve));
    }
  });
