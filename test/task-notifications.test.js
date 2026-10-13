import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../src/server.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';

test('task notifications stream across the local API without exposing the provider token or polling', async (t) => {
  let upstream;
  let calls = 0;
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const provider = createHttpServer((request, response) => {
    calls += 1;
    assert.equal(request.headers.authorization, 'Bearer synthetic-stream-token');
    assert.equal(request.url, '/v1/project-agent-task-events?personal_space_id=space-a');
    upstream = response;
    response.on('close', disconnected);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: ready\ndata: {}\n\n');
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const client = new GraphitiProviderClient({ baseUrl: `http://127.0.0.1:${provider.address().port}`,
    accessToken: 'synthetic-stream-token', requestTimeoutMs: 100 });
  const server = await createServer({ port: 0, app: {
    openProjectAgentTaskEvents: ({ personalSpaceId }, { signal }) => client.openProjectAgentTaskEvents(personalSpaceId, { signal })
  } });
  t.after(() => server.close());
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${server.url}/api/project-agent-task-events?personalSpaceId=space-a`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  await delay(150); // Header timeout must not terminate an established subscription.
  upstream.write('data: {"taskId":"task-a"}\n\n');
  assert.match(new TextDecoder().decode((await reader.read()).value), /"taskId":"task-a"/);
  assert.equal(calls, 1);
  abort.abort();
  await Promise.race([closed, delay(1000).then(() => { throw new Error('Upstream leaked after browser disconnect'); })]);
});

test('server shutdown releases notification streams, and provider errors remain ordinary HTTP errors', async (t) => {
  let aborted = false;
  const client = new GraphitiProviderClient({ baseUrl: 'http://fixture', accessToken: 'synthetic-token',
    fetchImpl: async (_url, { signal }) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
        signal.addEventListener('abort', () => controller.error(signal.reason));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
  });
  const server = await createServer({ port: 0, app: {
    openProjectAgentTaskEvents: (input, options) => client.openProjectAgentTaskEvents(input.personalSpaceId, options)
  } });
  t.after(() => server.close());
  const response = await fetch(`${server.url}/api/project-agent-task-events?personalSpaceId=space-a`);
  assert.equal(response.status, 200);
  await server.close();
  assert.equal(aborted, true);
  const rejected = new GraphitiProviderClient({ baseUrl: 'http://fixture', accessToken: 'synthetic-token',
    fetchImpl: async () => Response.json({ detail: 'Space access required' }, { status: 403 }) });
  await assert.rejects(rejected.openProjectAgentTaskEvents('other'), { status: 403 });
});
