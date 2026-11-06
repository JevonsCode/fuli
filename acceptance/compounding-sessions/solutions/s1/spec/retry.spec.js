import assert from 'node:assert/strict';
import { test } from 'node:test';
import { send } from '../src/channels/email.js';
import { fixtures, scriptedTransport } from './helpers.js';

const { email } = fixtures();

test('email retry: 5xx twice then success waits 200 then 400 ms', async () => {
  const waits = [];
  const { transport, calls } = scriptedTransport([{ status: 503 }, { status: 502 }, { status: 202, id: 'e-2' }]);
  assert.deepEqual(await send(email, { transport, sleep: async (ms) => waits.push(ms) }), { id: 'e-2' });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [200, 400]);
});

test('email retry: a 4xx is never retried', async () => {
  const { transport, calls } = scriptedTransport([{ status: 429 }]);
  await assert.rejects(send(email, { transport, sleep: async () => {} }), { code: 'TW-EMAIL-002' });
  assert.equal(calls.length, 1);
});

test('email retry: a network error is retried', async () => {
  const { transport, calls } = scriptedTransport([new Error('ECONNRESET'), { status: 202, id: 'e-3' }]);
  assert.deepEqual(await send(email, { transport, sleep: async () => {} }), { id: 'e-3' });
  assert.equal(calls.length, 2);
});
