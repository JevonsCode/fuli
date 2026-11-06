import assert from 'node:assert/strict';
import { test } from 'node:test';
import { send } from '../src/channels/sms.js';
import { fixtures, scriptedTransport } from './helpers.js';

const { sms, badSms } = fixtures();

test('sms: delivers through the transport', async () => {
  const { transport, calls } = scriptedTransport([{ status: 200, id: 's-1' }]);
  assert.deepEqual(await send(sms, { transport }), { id: 's-1' });
  assert.equal(calls[0].to, sms.to);
});

test('sms: refuses a number that is not E.164', async () => {
  const { transport } = scriptedTransport([{ status: 200 }]);
  await assert.rejects(send(badSms, { transport }), { code: 'TW-SMS-001' });
});

test('sms: provider refusal is a channel error', async () => {
  const { transport } = scriptedTransport([{ status: 400 }]);
  await assert.rejects(send(sms, { transport }), { code: 'TW-SMS-002' });
});
