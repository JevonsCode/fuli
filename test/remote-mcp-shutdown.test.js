import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test, { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import {
  TOKEN,
  UNREACHED_GRACE_MS,
  initializeBody,
  serverRequest,
  serverObservedAbort,
  closeObservedMcp,
  startRemote,
  rawJsonRequest,
  jsonRequest
} from '../test-support/remote-mcp.js';

// The remote MCP HTTP server's shutdown: initializations and responses in
// flight, the drain, and one grace deadline across it and the session closes.

test('remote MCP rejects an initialization that finishes connecting after shutdown starts', {
  timeout: 5_000
}, async (t) => {
  const connectStarted = Promise.withResolvers();
  const releaseConnect = Promise.withResolvers();
  const remote = await startRemote({
    shutdownGraceMs: UNREACHED_GRACE_MS,
    createMcp: () => ({
      connect: async () => {
        connectStarted.resolve();
        await releaseConnect.promise;
      },
      close: async () => {}
    })
  });
  t.after(() => {
    releaseConnect.resolve();
    return remote.close();
  });
  const responsePromise = rawJsonRequest(`${remote.url}/mcp`, initializeBody(), {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  });
  await connectStarted.promise;
  const closing = remote.close();
  releaseConnect.resolve();
  const response = await responsePromise;
  await closing;
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, -32000);
});

test('remote MCP lets a dispatched initialization finish within shutdown grace', {
  timeout: 5_000
}, async (t) => {
  const dispatchStarted = Promise.withResolvers();
  const releaseDispatch = Promise.withResolvers();
  const remote = await startRemote({
    shutdownGraceMs: UNREACHED_GRACE_MS,
    createMcp: (app, options) => {
      const mcp = createMcpServer(app, options);
      return {
        connect: async (transport) => {
          const handleRequest = transport.handleRequest.bind(transport);
          transport.handleRequest = async (request, response, body) => {
            if (body?.method === 'initialize') {
              dispatchStarted.resolve();
              await releaseDispatch.promise;
            }
            return handleRequest(request, response, body);
          };
          return mcp.connect(transport);
        },
        close: () => mcp.close()
      };
    }
  });
  t.after(() => {
    releaseDispatch.resolve();
    return remote.close();
  });
  let closing;
  try {
    const responsePromise = fetch(`${remote.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify(initializeBody())
    });
    await dispatchStarted.promise;
    closing = remote.close();
    await delay(25);
    releaseDispatch.resolve();
    const response = await responsePromise;
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /"protocolVersion"/);
    await closing;
  } finally {
    releaseDispatch.resolve();
    await (closing ?? remote.close()).catch(() => {});
  }
});

test('remote MCP reconciles a response closed before in-flight listeners attach', {
  timeout: 5_000
}, async (t) => {
  const connectStarted = Promise.withResolvers();
  const releaseConnect = Promise.withResolvers();
  const dispatchStarted = Promise.withResolvers();
  const releaseDispatch = Promise.withResolvers();
  const remote = await startRemote({
    // close() can settle only by reconciling the already-closed response; a
    // held in-flight counter would wait for the grace and time the test out.
    shutdownGraceMs: UNREACHED_GRACE_MS,
    createMcp: (app, options) => {
      const mcp = createMcpServer(app, options);
      return {
        connect: async (transport) => {
          await mcp.connect(transport);
          const handleRequest = transport.handleRequest.bind(transport);
          transport.handleRequest = async (...args) => {
            dispatchStarted.resolve();
            await releaseDispatch.promise;
            return handleRequest(...args);
          };
          connectStarted.resolve();
          await releaseConnect.promise;
        },
        close: () => mcp.close()
      };
    }
  });
  t.after(() => {
    releaseConnect.resolve();
    releaseDispatch.resolve();
    return remote.close();
  });
  const body = JSON.stringify(initializeBody());
  const request = httpRequest(`${remote.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': Buffer.byteLength(body)
    }
  });
  t.after(() => request.destroy());
  request.on('error', () => {});
  const aborted = serverObservedAbort(remote);
  request.end(body);
  await connectStarted.promise;
  request.destroy();
  await aborted;
  releaseConnect.resolve();
  await dispatchStarted.promise;
  const closing = remote.close();
  releaseDispatch.resolve();
  await closing;
  assert.deepEqual(remote.stats(), {
    activeSessions: 0,
    pendingSessions: 0,
    closing: true
  });
});

test('remote MCP removes an initialized session whose response was not delivered', {
  timeout: 5_000
}, async (t) => {
  const connectStarted = Promise.withResolvers();
  const releaseConnect = Promise.withResolvers();
  const dispatchFinished = Promise.withResolvers();
  const remote = await startRemote({
    createMcp: (app, options) => {
      const mcp = createMcpServer(app, options);
      return {
        connect: async (transport) => {
          await mcp.connect(transport);
          const handleRequest = transport.handleRequest.bind(transport);
          transport.handleRequest = async (...args) => {
            try {
              return await handleRequest(...args);
            } finally {
              dispatchFinished.resolve();
            }
          };
          connectStarted.resolve();
          await releaseConnect.promise;
        },
        close: () => mcp.close()
      };
    }
  });
  t.after(() => {
    releaseConnect.resolve();
    return remote.close();
  });
  const body = JSON.stringify(initializeBody());
  const request = httpRequest(`${remote.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': Buffer.byteLength(body)
    }
  });
  t.after(() => request.destroy());
  request.on('error', () => {});
  const aborted = serverObservedAbort(remote);
  request.end(body);
  try {
    await connectStarted.promise;
    request.destroy();
    await aborted;
    releaseConnect.resolve();
    await dispatchFinished.promise;
    await delay(10);
    assert.deepEqual(remote.stats(), {
      activeSessions: 0,
      pendingSessions: 0,
      closing: false
    });
  } finally {
    releaseConnect.resolve();
    await remote.close();
  }
});

test('remote MCP does not refresh idle liveness for an aborted POST', {
  timeout: 5_000
}, async (t) => {
  let clock = 1_000;
  const callStarted = Promise.withResolvers();
  const releaseCall = Promise.withResolvers();
  const callFinished = Promise.withResolvers();
  const session = closeObservedMcp();
  const remote = await startRemote({
    createMcp: session.createMcp,
    app: {
      getCollaborationPreferences: async () => {
        callStarted.resolve();
        await releaseCall.promise;
        callFinished.resolve();
        return { effective_preferences: [], deferred_conflicts: [] };
      }
    },
    now: () => clock,
    sessionIdleTtlMs: 1_000,
    sessionSweepIntervalMs: 10
  });
  t.after(() => {
    releaseCall.resolve();
    return remote.close();
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-aborted-call-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const sessionId = transport.sessionId;
  await client.close();
  await delay(10);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 91,
    method: 'tools/call',
    params: {
      name: 'get_collaboration_preferences',
      arguments: { sessionId: 'remote', projectPath: '.' }
    }
  });
  const request = httpRequest(`${remote.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': '2025-06-18',
      'content-length': Buffer.byteLength(body)
    }
  });
  t.after(() => request.destroy());
  request.on('error', () => {});
  request.on('response', response => response.resume());
  const aborted = serverObservedAbort(
    remote,
    incoming => incoming.method === 'POST' && incoming.headers['mcp-session-id'] === sessionId
  );
  request.end(body);
  try {
    await callStarted.promise;
    request.destroy();
    await aborted;
    clock = 1_500;
    releaseCall.resolve();
    await callFinished.promise;
    // Past the TTL from the initialization, but not from the aborted call. An
    // aborted call that refreshed liveness would never be evicted.
    clock = 2_101;
    await session.closed;
    assert.equal(remote.stats().activeSessions, 0);
  } finally {
    releaseCall.resolve();
    await remote.close();
  }
});

test('remote MCP bounds shutdown even when a client trickles a request body', {
  timeout: 5_000
}, async (t) => {
  const remote = await startRemote({ shutdownGraceMs: 20 });
  t.after(() => remote.close());
  const body = JSON.stringify(initializeBody());
  const request = httpRequest(`${remote.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    }
  });
  t.after(() => request.destroy());
  request.on('error', () => {});
  const uploading = serverRequest(remote);
  request.write(body.slice(0, 8));
  await uploading;
  // The client never finishes its body, so close() can settle only through the
  // shutdown grace; an unbounded shutdown times the test out.
  await remote.close();
  assert.equal(remote.server.listening, false);
  request.destroy();
});

test('remote MCP lets an in-flight tool response finish within shutdown grace', {
  timeout: 5_000
}, async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const remote = await startRemote({
    app: {
      getCollaborationPreferences: async () => {
        started.resolve();
        await release.promise;
        return { effective_preferences: [], deferred_conflicts: [] };
      }
    },
    shutdownGraceMs: UNREACHED_GRACE_MS
  });
  t.after(() => {
    release.resolve();
    return remote.close();
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-shutdown-drain-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const call = client.callTool({
    name: 'get_collaboration_preferences',
    arguments: { sessionId: 'remote', projectPath: '.' }
  });
  await Promise.race([started.promise, call]);
  const closing = remote.close();
  await delay(25);
  release.resolve();
  const result = await call;
  assert.equal(result.isError, undefined, JSON.stringify(result));
  await closing;
  await client.close().catch(() => {});
});

// Real I/O still runs between mocked ticks; only setTimeout and Date are frozen.
async function settleIo(turns = 20) {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('remote MCP honours the configured shutdown grace as one deadline across drain and session close', {
  timeout: 5_000
}, async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const remote = await startRemote({
    app: {
      getCollaborationPreferences: async () => {
        started.resolve();
        await release.promise;
        return { effective_preferences: [], deferred_conflicts: [] };
      }
    },
    // Five times the 2 s default, so a fallback to the default settles early.
    shutdownGraceMs: 10_000,
    createMcp: (app, options) => {
      const mcp = createMcpServer(app, options);
      return { connect: transport => mcp.connect(transport), close: () => new Promise(() => {}) };
    }
  });
  t.after(async () => {
    release.resolve();
    // Fire any mocked shutdown timer a regression left pending so close() settles.
    if (mockedClock) mock.timers.tick(60_000);
    mock.timers.reset();
    remote.server.closeAllConnections?.();
    await remote.close();
  });
  let mockedClock = false;
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-shutdown-clock-test', version: '1.0.0' });
  t.after(() => client.close().catch(() => {}));
  await client.connect(transport);
  // Enabled before the call so the client's request timer is mocked and cleared with it.
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  mockedClock = true;
  const call = client.callTool({
    name: 'get_collaboration_preferences',
    arguments: { sessionId: 'remote', projectPath: '.' }
  });
  await started.promise;
  let closed = false;
  const closing = remote.close().then(() => { closed = true; });
  await settleIo();

  mock.timers.tick(2_000);
  await settleIo();
  assert.equal(closed, false, 'shutdown must not fall back to the 2 s default grace');

  // The in-flight call drains at 4 s; the hung session close gets only what is left.
  mock.timers.tick(2_000);
  release.resolve();
  const result = await call;
  assert.equal(result.isError, undefined, JSON.stringify(result));
  await settleIo();

  mock.timers.tick(5_999);
  await settleIo();
  assert.equal(closed, false, 'shutdown must wait for the whole configured grace');

  mock.timers.tick(1);
  await settleIo();
  assert.equal(closed, true, 'drain and session close share one deadline');
  await closing;
  assert.equal(remote.server.listening, false);
});

test('remote MCP absorbs synchronous session-close failures', async (t) => {
  const app = {
    getCollaborationPreferences: async () => ({
      effective_preferences: [], deferred_conflicts: []
    })
  };
  const remote = await startRemote({
    app,
    createMcp: (boundApp, options) => {
      const mcp = createMcpServer(boundApp, options);
      return {
        connect: transport => mcp.connect(transport),
        close: () => { throw new Error('synthetic synchronous close failure'); }
      };
    }
  });
  t.after(() => remote.close());
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-close-failure-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  await remote.close();
  await client.close().catch(() => {});
});

test('remote MCP bounds shutdown when a session close never settles', {
  timeout: 5_000
}, async (t) => {
  const remote = await startRemote({
    shutdownGraceMs: 20,
    createMcp: (app, options) => {
      const mcp = createMcpServer(app, options);
      return {
        connect: transport => mcp.connect(transport),
        close: () => new Promise(() => {})
      };
    }
  });
  t.after(() => remote.close());
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-hung-close-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  // The session close never settles, so close() can settle only through the
  // 20 ms shutdown grace. The guard only tells that apart from a hang; it does
  // not measure how fast a loaded scheduler reaches the deadline.
  const outcome = await Promise.race([
    remote.close().then(() => 'closed'),
    delay(4_000, 'timed-out', { ref: false })
  ]);
  await client.close().catch(() => {});
  if (outcome !== 'closed') {
    remote.server.closeAllConnections?.();
    remote.server.close();
  }
  assert.equal(outcome, 'closed');
});

test('remote MCP rejects an initialization whose body finishes after shutdown starts', {
  timeout: 5_000
}, async (t) => {
  let sessionsCreated = 0;
  const remote = await startRemote({
    shutdownGraceMs: UNREACHED_GRACE_MS,
    createMcp: (app, options) => {
      sessionsCreated += 1;
      return createMcpServer(app, options);
    }
  });
  t.after(() => remote.close());
  const body = JSON.stringify(initializeBody());
  const splitAt = Math.floor(body.length / 2);
  const uploading = serverRequest(remote);
  const { request, response: responsePromise } = jsonRequest(`${remote.url}/mcp`, {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'content-length': Buffer.byteLength(body)
  });
  request.write(body.slice(0, splitAt));
  await uploading;
  const closing = remote.close();
  request.end(body.slice(splitAt));
  const response = await responsePromise;
  await closing;
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, -32000);
  assert.equal(sessionsCreated, 0);
  assert.deepEqual(remote.stats(), {
    activeSessions: 0,
    pendingSessions: 0,
    closing: true
  });
});
