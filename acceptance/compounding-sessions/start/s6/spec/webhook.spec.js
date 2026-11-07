import assert from 'node:assert/strict';
import { test } from 'node:test';
import { send } from '../src/channels/webhook.js';
import { scriptedTransport } from './helpers.js';

const hook = { channel: 'webhook', url: 'https://hooks.tidewater.example/in', body: { level: 3.2 } };

test('webhook: POSTs to the message URL with the retry policy', async () => {
  const waits = [];
  const { transport, calls } = scriptedTransport([{ status: 503 }, { status: 204, id: 'w-1' }]);
  assert.deepEqual(await send(hook, { transport, sleep: async (ms) => waits.push(ms) }), { id: 'w-1' });
  assert.equal(calls[0].url, hook.url);
  assert.deepEqual(waits, [200]);
});

test('webhook: a 4xx gets the full retry budget', async () => {
  const { transport, calls } = scriptedTransport([{ status: 410 }]);
  await assert.rejects(send(hook, { transport, sleep: async () => {} }), { code: 'TW-WEBHOOK-002' });
  assert.equal(calls.length, 3);
});
