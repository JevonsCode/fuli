import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { modelFetch } from '../src/model-backends/model-fetch.js';
import { fetchWithoutRedirect, RedirectRefusedError } from '../src/model-backends/no-redirect-fetch.js';

// A port fetch itself refuses, so the test proves the way around it.
const BLOCKED_PORT = 6669;

async function server(t, handler) {
  const listening = createServer(handler);
  await new Promise((resolve, reject) => {
    listening.once('error', reject);
    listening.listen(BLOCKED_PORT, '127.0.0.1', resolve);
  }).catch((error) => { if (error.code === 'EADDRINUSE') t.skip('the test port is in use'); else throw error; });
  t.after(() => new Promise(done => { listening.close(done); listening.closeAllConnections(); }));
  return `http://127.0.0.1:${BLOCKED_PORT}/v1/messages`;
}

test('a model server on a port fetch refuses still gets the request and answers', async (t) => {
  let seen = null;
  const url = await server(t, (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seen = { method: request.method, key: request.headers['x-api-key'], body: Buffer.concat(chunks).toString() };
      response.writeHead(200, { 'content-type': 'application/json', 'retry-after': '1' });
      response.end('{"ok":true}');
    });
  });
  await assert.rejects(fetch(url), error => error.cause?.message === 'bad port', 'plain fetch refuses this port');
  const answer = await modelFetch(url, { method: 'POST', headers: { 'x-api-key': 'synthetic-key' }, body: '{"a":1}' });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('retry-after'), '1');
  assert.deepEqual(await answer.json(), { ok: true });
  assert.deepEqual(seen, { method: 'POST', key: 'synthetic-key', body: '{"a":1}' });
});

test('that way round still refuses a redirect and honours an abort', async (t) => {
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  const url = await server(t, (request, response) => {
    if (request.url.endsWith('/slow')) { reached(); return; }
    response.writeHead(307, { location: 'http://example.test/' });
    response.end();
  });
  await assert.rejects(fetchWithoutRedirect(modelFetch, url, { method: 'POST', body: '{}' }), RedirectRefusedError);
  const controller = new AbortController();
  const pending = modelFetch(`${url}/slow`, { method: 'POST', body: '{}', signal: controller.signal });
  await arrived;
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('that way round a body still being read ends with why it was cut, so a time limit reads as a timeout', async (t) => {
  const url = await server(t, (request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"part":1}\n\n');
  });
  const answer = await modelFetch(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(100) });
  const reader = answer.body.getReader();
  assert.equal((await reader.read()).done, false, 'the first chunk arrived');
  await assert.rejects(reader.read(), error => error.name === 'TimeoutError');
});
