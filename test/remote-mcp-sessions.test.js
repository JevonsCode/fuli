import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  TOKEN,
  initializeBody,
  serverRequest,
  closeObservedMcp,
  startRemote,
  jsonRequest
} from '../test-support/remote-mcp.js';

// The remote MCP HTTP server's sessions: the cap on active ones, and idle
// eviction that never ends a session still answering.

test('remote MCP closes rejected initializations and caps active sessions', async (t) => {
  const remote = await startRemote({ maxSessions: 1 });
  t.after(() => remote.close());

  const rejected = await fetch(`${remote.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(initializeBody())
  });
  assert.equal(rejected.status, 406);
  await delay(0);
  assert.deepEqual(remote.stats(), {
    activeSessions: 0,
    pendingSessions: 0,
    closing: false
  });

  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-session-cap-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(remote.stats().activeSessions, 1);

  const overflow = await fetch(`${remote.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(initializeBody(3))
  });
  assert.equal(overflow.status, 503);
  assert.equal(remote.stats().activeSessions, 1);
});

test('remote MCP evicts abandoned sessions after the idle TTL', {
  timeout: 5_000
}, async (t) => {
  let clock = 0;
  const session = closeObservedMcp();
  const remote = await startRemote({
    sessionIdleTtlMs: 20,
    sessionSweepIntervalMs: 5,
    now: () => clock,
    createMcp: session.createMcp
  });
  t.after(() => remote.close());
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-session-ttl-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(remote.stats().activeSessions, 1);
  await client.close();
  clock = 21;
  // The sweeper retires the expired session; wait for that close, not for time.
  await session.closed;
  assert.equal(remote.stats().activeSessions, 0);
});

test('remote MCP idle-evicts a silent session even with an open SSE stream', {
  timeout: 5_000
}, async (t) => {
  let clock = 1_000;
  const session = closeObservedMcp();
  const remote = await startRemote({
    sessionIdleTtlMs: 100,
    sessionSweepIntervalMs: 10,
    now: () => clock,
    createMcp: session.createMcp
  });
  t.after(() => remote.close());
  const initialized = await fetch(`${remote.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(initializeBody())
  });
  const sessionId = initialized.headers.get('mcp-session-id');
  assert.ok(sessionId);
  await initialized.text();
  const stream = await fetch(`${remote.url}/mcp`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'text/event-stream',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': '2025-06-18'
    }
  });
  assert.equal(stream.status, 200);
  // The standalone stream stays open while the session expires; it is not
  // application activity, so the sweeper still retires the session and ends it.
  clock += 101;
  await session.closed;
  assert.equal(remote.stats().activeSessions, 0);
  await stream.text().catch(() => {});
});

test('remote MCP accepts a session TTL shorter than the normal sweep interval', async (t) => {
  const remote = await startRemote({ sessionIdleTtlMs: 10_000 });
  t.after(() => remote.close());
  assert.equal(remote.stats().activeSessions, 0);
});

test('remote MCP does not idle-evict a long-running tool response', {
  timeout: 5_000
}, async (t) => {
  let clock = 1_000;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const sessions = closeObservedMcp();
  const remote = await startRemote({
    app: {
      getCollaborationPreferences: async () => {
        started.resolve();
        await release.promise;
        return { effective_preferences: [], deferred_conflicts: [] };
      }
    },
    sessionIdleTtlMs: 20,
    sessionSweepIntervalMs: 5,
    now: () => clock,
    createMcp: sessions.createMcp
  });
  t.after(() => {
    release.resolve();
    return remote.close();
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-long-call-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  // A second, idle session expires with the busy one. Its eviction proves a
  // sweep ran after the clock moved; one sweep visits every session.
  const idleTransport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const idleClient = new Client({ name: 'fuli-long-call-idle', version: '1.0.0' });
  t.after(() => idleClient.close());
  await idleClient.connect(idleTransport);
  await idleClient.close();
  assert.equal(remote.stats().activeSessions, 2);
  const call = client.callTool({
    name: 'get_collaboration_preferences',
    arguments: { sessionId: 'remote', projectPath: '.' }
  });
  await Promise.race([started.promise, call]);
  // Advance the idle clock only after dispatch; scheduler load must not expire
  // the session while this test is still arranging the in-flight request.
  clock += 60;
  await sessions.closed;
  assert.equal(remote.stats().activeSessions, 1);
  release.resolve();
  const result = await call;
  assert.equal(result.isError, undefined, JSON.stringify(result));
});

test('remote MCP reclaims an already-expired slot before rejecting a new session', async (t) => {
  let clock = 1_000;
  const remote = await startRemote({
    maxSessions: 1,
    sessionIdleTtlMs: 1_000,
    sessionSweepIntervalMs: 1_000,
    now: () => clock
  });
  t.after(() => remote.close());
  const firstTransport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const firstClient = new Client({ name: 'fuli-expired-slot-one', version: '1.0.0' });
  t.after(() => firstClient.close());
  await firstClient.connect(firstTransport);
  assert.equal(remote.stats().activeSessions, 1);

  await firstClient.close();
  await delay(10);
  clock += 1_001;
  const secondTransport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const secondClient = new Client({ name: 'fuli-expired-slot-two', version: '1.0.0' });
  t.after(() => secondClient.close());
  await secondClient.connect(secondTransport);
  assert.equal(remote.stats().activeSessions, 1);
  await firstClient.close().catch(() => {});
});

test('remote MCP re-resolves a session evicted while a POST body is uploading', {
  timeout: 5_000
}, async (t) => {
  let clock = 1_000;
  const session = closeObservedMcp();
  const remote = await startRemote({
    sessionIdleTtlMs: 20,
    sessionSweepIntervalMs: 5,
    now: () => clock,
    createMcp: session.createMcp
  });
  t.after(() => remote.close());
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-upload-eviction-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const sessionId = transport.sessionId;
  await client.close();
  const body = `${' '.repeat(1024)}${JSON.stringify({
    jsonrpc: '2.0', id: 77, method: 'tools/list', params: {}
  })}`;
  const splitAt = Math.floor(body.length / 2);
  const uploading = serverRequest(remote, request => request.method === 'POST');
  const { request, response: responsePromise } = jsonRequest(`${remote.url}/mcp`, {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-06-18',
    'content-length': Buffer.byteLength(body)
  });
  request.write(body.slice(0, splitAt));
  // The handler resolved the live session from the headers and is now reading
  // the body. Expire it and let the sweeper retire it before the upload ends.
  await uploading;
  clock += 1_000;
  await session.closed;
  request.end(body.slice(splitAt));
  const response = await responsePromise;
  assert.equal(response.status, 404);
  assert.equal(response.body.error.message, 'Invalid or missing MCP session');
  assert.equal(remote.stats().activeSessions, 0);
});
