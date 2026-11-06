import assert from 'node:assert/strict';
import { test } from 'node:test';
import { port } from '../src/config.js';
import { start } from '../src/server.js';

test('server: GET /healthz on the e2e port lists the channels', async () => {
  const server = await start({ port: port('e2e') });
  try {
    const response = await fetch(`http://127.0.0.1:${port('e2e')}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', channels: ['email', 'sms', 'webhook'] });
  } finally {
    server.close();
  }
});
