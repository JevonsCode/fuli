import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';

function call(body, app) {
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', headers: { 'content-type': 'application/json' } });
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  return handleGraphApiRequest({ request, response, url: new URL('http://127.0.0.1/api/conversation-triage/record'), app })
    .then(handled => ({ handled, ...sent }));
}

test('the pages record a person correction through the owner triage route', async () => {
  const received = [];
  const app = { recordConversationTriage: async input => { received.push(input); return { triage: { kind: input.kind } }; } };
  const result = await call({ personalSpaceId: 'space', conversationId: 'c-1', kind: 'one_off' }, app);
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.deepEqual(received, [{ personalSpaceId: 'space', conversationId: 'c-1', kind: 'one_off' }]);
});
