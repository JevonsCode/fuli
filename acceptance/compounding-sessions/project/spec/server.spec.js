import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from '../src/server.js';
import { fixtures, scriptedTransport } from './helpers.js';

const { email } = fixtures();

test('server: POST /relay relays the message', async () => {
  const mail = scriptedTransport([{ status: 202, id: 'e-5' }]);
  const server = await start({ port: 0, transports: { email: mail.transport } });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/relay`, { method: 'POST', body: JSON.stringify(email) });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { id: 'e-5' });
  } finally {
    server.close();
  }
});

test('server: unknown paths are 404', async () => {
  const server = await start({ port: 0 });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(response.status, 404);
  } finally {
    server.close();
  }
});
