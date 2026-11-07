import assert from 'node:assert/strict';
import { test } from 'node:test';
import { send } from '../src/channels/push.js';
import { scriptedTransport } from './helpers.js';

test('push: sends to the provider sandbox with the key header and the retry policy', async () => {
  process.env.TIDE_PUSH_KEY = 'spec-key';
  const waits = [];
  const { transport, calls } = scriptedTransport([{ status: 503 }, { status: 200, id: 'p-1' }]);
  assert.deepEqual(await send({ channel: 'push', to: 'device-1', body: 'hi' }, { transport, sleep: async (ms) => waits.push(ms) }), { id: 'p-1' });
  assert.ok(calls[0].url.startsWith('https://sandbox.tidepush.example/v2'));
  assert.equal(calls[0].headers['X-Tide-Key'], 'spec-key');
  assert.deepEqual(waits, [200]);
});

test('push: a 4xx is never retried', async () => {
  const { transport, calls } = scriptedTransport([{ status: 401 }]);
  await assert.rejects(send({ channel: 'push', to: 'device-1' }, { transport, sleep: async () => {} }), { code: 'TW-PUSH-002' });
  assert.equal(calls.length, 1);
});
