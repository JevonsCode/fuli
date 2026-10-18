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

test('the existing SSE carries chat metadata from the roundtable without message bodies', async t => {
  const { createRoundtableStore } = await import('../src/agent-roundtable/store.js');
  const { createAgentRoundtable } = await import('../src/agent-roundtable/service.js');
  const app = { config: { personal: { spaceId: 'space-a' } },
    listProjectAgents: async () => ['alpha','beta'].map(agentId => ({ agentId, profile: { name: agentId, status: 'active' } })),
    taskContextRegistry: { context: async token => ({ projectAgentId: token, personalProjectId: 'project' }) },
    openProjectAgentTaskEvents: async (_input, { signal }) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
      signal.addEventListener('abort', () => controller.close(), { once: true });
    } })) };
  app.roundtable = createAgentRoundtable({ app, openStore: () => createRoundtableStore() });
  const server = await createServer({ port: 0, app });
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await server.close(); app.roundtable.close(); });
  const response = await fetch(`${server.url}/api/project-agent-task-events?personalSpaceId=space-a`, { signal: abort.signal });
  const reader = response.body.getReader();
  await reader.read();
  const chat = (action, data) => app.roundtable.chat({ taskContextToken: 'alpha', action, ...data });
  const { chatId } = await chat('create', { requestId: 'sse-room', kind: 'direct', members: ['local:beta'] });
  await chat('send', { chatId, requestId: 'sse-message', body: 'private body' });
  let text = '';
  const read = (async () => { while (!text.includes('"seq":1')) text += new TextDecoder().decode((await reader.read()).value); })();
  await Promise.race([read, delay(1000).then(() => { throw new Error('chat event missing'); })]);
  assert.match(text, /event: chat/);
  assert.ok(!text.includes('private body'));
  for (const frame of text.split('\n\n').filter(frame => frame.includes('event: chat'))) {
    assert.deepEqual(Object.keys(JSON.parse(frame.split('data: ')[1])).sort(), ['chatId','seq']);
  }
});

test('peer notification failure leaves the local task SSE connected', async t => {
  let notify, upstream;
  const app={config:{personal:{spaceId:'space'}},roundtable:{subscribeChatUpdates:listener=>{notify=listener;return()=>{};}},
    openProjectAgentTaskEvents:async(_input,{signal})=>new Response(new ReadableStream({start(controller){
      upstream=controller;controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
      signal.addEventListener('abort',()=>controller.close(),{once:true});
    }}))};
  const server=await createServer({port:0,app});const abort=new AbortController();
  t.after(async()=>{abort.abort();await server.close();});
  const response=await fetch(`${server.url}/api/project-agent-task-events?personalSpaceId=space`,{signal:abort.signal});
  const reader=response.body.getReader();await reader.read();
  notify(null,new Error('coordinator offline'));
  assert.match(new TextDecoder().decode((await reader.read()).value),/event: chat-unavailable/);
  upstream.enqueue(new TextEncoder().encode('data: {"taskId":"still-live"}\n\n'));
  assert.match(new TextDecoder().decode((await reader.read()).value),/still-live/);
});
