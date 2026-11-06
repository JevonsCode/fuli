import assert from 'node:assert/strict';
import { test } from 'node:test';
import { send } from '../src/channels/email.js';
import { fixtures, scriptedTransport } from './helpers.js';

const { email, badEmail } = fixtures();

test('email: delivers through the transport', async () => {
  const { transport, calls } = scriptedTransport([{ status: 202, id: 'e-1' }]);
  assert.deepEqual(await send(email, { transport }), { id: 'e-1' });
  assert.equal(calls[0].to, email.to);
});

test('email: refuses a recipient that is not an address', async () => {
  const { transport } = scriptedTransport([{ status: 202 }]);
  await assert.rejects(send(badEmail, { transport }), { code: 'TW-EMAIL-001' });
});

test('email: provider refusal is a channel error', async () => {
  const { transport } = scriptedTransport([{ status: 422 }]);
  await assert.rejects(send(email, { transport }), { code: 'TW-EMAIL-002' });
});
