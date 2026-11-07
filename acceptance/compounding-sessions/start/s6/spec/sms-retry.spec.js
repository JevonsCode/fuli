import assert from 'node:assert/strict';
import { test } from 'node:test';
import { send } from '../src/channels/sms.js';
import { fixtures, scriptedTransport } from './helpers.js';

const { sms } = fixtures();

test('sms retry: 5xx twice then success waits 200 then 400 ms', async () => {
  const waits = [];
  const { transport, calls } = scriptedTransport([{ status: 500 }, { status: 503 }, { status: 200, id: 's-2' }]);
  assert.deepEqual(await send(sms, { transport, sleep: async (ms) => waits.push(ms) }), { id: 's-2' });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [100, 200]);
});

test('sms retry: a 4xx is never retried', async () => {
  const { transport, calls } = scriptedTransport([{ status: 404 }]);
  await assert.rejects(send(sms, { transport, sleep: async () => {} }), { code: 'TW-SMS-002' });
  assert.equal(calls.length, 1);
});
