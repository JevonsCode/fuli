import assert from 'node:assert/strict';
import test from 'node:test';

import { handleSessionLaunchRequest } from '../../src/http/session-launch-api-router.js';
import { createDoctor } from '../../src/system/doctor.js';

function call(path, { method = 'GET', system } = {}) {
  const sent = [];
  const response = { setHeader() {}, writeHead(status) { sent.push(status); return this; }, end(text) { sent.push(JSON.parse(text)); } };
  return handleSessionLaunchRequest({ request: { method }, response, url: new URL(path, 'http://127.0.0.1'), system })
    .then((handled) => ({ handled, sent }));
}

test('the console reads session offers by source application and session ID, opening nothing', async () => {
  const asked = [];
  const system = { sessionLaunchOffers: async (sessions) => { asked.push(sessions); return { launcher: 'unavailable' }; } };
  assert.deepEqual(await call('/api/session-launch/offers?session=codex:thread:1&session=claude_code:abc&session=codex:thread:1', { system }),
    { handled: true, sent: [200, { launcher: 'unavailable' }] });
  assert.deepEqual(asked, [[{ sourceApplication: 'codex', sessionId: 'thread:1' },
    { sourceApplication: 'claude_code', sessionId: 'abc' }]]);
  assert.deepEqual(await call('/api/session-launch/offers', { method: 'POST', system }),
    { handled: true, sent: [405, { error: 'Method not allowed' }] });
  assert.equal((await call('/api/session-launch/open', { system })).handled, false, 'no route opens a session');
  await assert.rejects(call('/api/session-launch/offers?session=unknown:abc', { system }), { code: 'invalid_input' });
  await assert.rejects(call('/api/session-launch/offers?session=abc', { system }), { code: 'invalid_input' });
  const many = Array.from({ length: 21 }, (_, index) => `session=codex:${index}`).join('&');
  await assert.rejects(call(`/api/session-launch/offers?${many}`, { system }), { code: 'invalid_input' });
});

test('the doctor carries the installer comparison without changing what it tells the person', async () => {
  const read = (internalDetails) => createDoctor({ observeClients: () => ({ clients: [] }), liveProcesses: () => [],
    latestVersion: () => null, lastUpdate: () => null, internalDetails, now: () => new Date(0) }).check();
  const without = await read(null);
  const withShadow = await read(() => ({ installerShadow: { status: 'pending' } }));
  assert.equal('internal' in without, false);
  assert.deepEqual(withShadow.internal, { installerShadow: { status: 'pending' } });
  const { internal: _internal, ...rest } = withShadow;
  assert.deepEqual(rest, without);
});
