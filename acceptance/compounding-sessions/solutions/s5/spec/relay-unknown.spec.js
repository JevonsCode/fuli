import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relay } from '../src/relay.js';

test('relay: an unknown channel is a channel error', async () => {
  await assert.rejects(relay({ channel: 'pigeon', to: 'x' }, { transports: {} }), { name: 'ChannelError', code: 'TW-RELAY-001' });
});
