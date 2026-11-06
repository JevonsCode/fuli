import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relay } from '../src/relay.js';
import { fixtures, scriptedTransport } from './helpers.js';

const { email, sms } = fixtures();

test('relay: routes each message to its channel transport', async () => {
  const mail = scriptedTransport([{ status: 202, id: 'e-9' }]);
  const text = scriptedTransport([{ status: 200, id: 's-9' }]);
  const transports = { email: mail.transport, sms: text.transport };
  assert.deepEqual(await relay(email, { transports }), { id: 'e-9' });
  assert.deepEqual(await relay(sms, { transports }), { id: 's-9' });
  assert.equal(mail.calls.length, 1);
  assert.equal(text.calls.length, 1);
});
