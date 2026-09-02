import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { createRemoteMcpHttpServer } from '../src/mcp/remote-http-server.js';

const TOKEN = 'synthetic-remote-mcp-token-1234567890';

function initializeBody(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fuli-remote-test', version: '1.0.0' }
    }
  };
}

async function startRemote(options = {}) {
  return createRemoteMcpHttpServer({
    app: {},
    host: '127.0.0.1',
    port: 0,
    bearerToken: TOKEN,
    personalProjectId: 'project-1',
    personalSpaceId: 'space-1',
    sourceApplication: 'claude',
    shutdownGraceMs: 50,
    ...options
  });
}

test('remote MCP requires bearer auth and binds Claude to one project and host session', {
  timeout: 10_000
}, async (t) => {
  const calls = [];
  const checkpointCalls = [];
  const verificationCalls = [];
  const boundCalls = new Map();
  const captureBoundCall = (name) => async (input) => {
    boundCalls.set(name, input);
    return { status: 'ok' };
  };
  const app = {
    beginTaskContext: async (input) => {
      boundCalls.set('begin_task_context', input);
      return { status: 'ok', context: {
        personal_project_id: input.personalProjectId,
        project_agent_id: 'agent-1'
      } };
    },
    getCollaborationPreferences: async (input) => {
      calls.push(input);
      return {
        effective_preferences: [],
        deferred_conflicts: [],
        context: {
          personal_space_id: 'space-1',
          personal_project_id: input.personalProjectId,
          project_agent_id: 'agent-1'
        },
        project_agent_context: {
          status: 'ready',
          project_agent_id: 'agent-1',
          personal_project_id: input.personalProjectId,
          source_application: input.sourceApplication
        }
      };
    },
    checkpointTaskKnowledge: async (input) => {
      checkpointCalls.push(input);
      return { status: 'completed' };
    },
    verifyTaskCheckpoint: async (input) => {
      verificationCalls.push(input);
      return { decision: 'allow' };
    },
    searchCurrentProjectKnowledge: captureBoundCall('search_current_project_knowledge'),
    getProjectAgentContext: captureBoundCall('get_project_agent_context'),
    getProjectAgentMemory: captureBoundCall('get_project_agent_memory'),
    viewProjectAgentActivity: captureBoundCall('view_project_agent_activity'),
    viewProjectAgentTask: captureBoundCall('view_project_agent_task')
  };
  const remote = await createRemoteMcpHttpServer({
    app,
    host: '127.0.0.1',
    port: 0,
    bearerToken: TOKEN,
    personalProjectId: 'project-1',
    personalSpaceId: 'space-1',
    sourceApplication: 'claude'
  });
  t.after(() => remote.close());

  const unauthorized = await fetch(`${remote.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer');

  const crossOrigin = await fetch(`${remote.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      origin: 'https://attacker.example'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  assert.equal(crossOrigin.status, 403);

  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-remote-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name).sort(), [
    'begin_task_context',
    'checkpoint_task_knowledge',
    'get_collaboration_preferences',
    'get_project_agent_context',
    'get_project_agent_memory',
    'search_current_project_knowledge',
    'verify_task_checkpoint',
    'view_project_agent_activity',
    'view_project_agent_task'
  ]);

  const result = await client.callTool({
    name: 'get_collaboration_preferences',
    arguments: {
      sessionId: 'forged-session',
      projectPath: '/forged/project',
      personalProjectId: 'forged-project',
      projectAgentId: 'forged-agent',
      taskPrompt: 'Continue the same project role.'
    }
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.context.personal_project_id, 'project-1');
  assert.equal(result.structuredContent.project_agent_context.source_application, 'claude');
  assert.equal(calls.length, 1);
  assert.deepEqual({
    projectPath: calls[0].projectPath,
    personalProjectId: calls[0].personalProjectId,
    sourceApplication: calls[0].sourceApplication,
    sessionId: calls[0].sessionId,
    sourceSessionId: calls[0].sourceSessionId,
    projectAgentId: calls[0].projectAgentId
  }, {
    projectPath: null,
    personalProjectId: 'project-1',
    sourceApplication: 'claude',
    sessionId: calls[0].sourceSessionId,
    sourceSessionId: calls[0].sourceSessionId,
    projectAgentId: null
  });
  assert.match(calls[0].sourceSessionId, /^fuli-remote-/);

  const validCheckpoint = await client.callTool({
    name: 'checkpoint_task_knowledge',
    arguments: {
      taskContextToken: 'synthetic-token',
      disposition: 'retain_nothing',
      reason: 'Nothing durable changed.'
    }
  });
  assert.equal(validCheckpoint.isError, undefined, JSON.stringify(validCheckpoint));
  assert.equal(checkpointCalls.length, 1);
  assert.equal(checkpointCalls[0].sourceApplication, 'claude');
  assert.equal(checkpointCalls[0].personalProjectId, 'project-1');
  assert.equal(checkpointCalls[0].remoteSessionId, checkpointCalls[0].sourceSessionId);
  assert.match(checkpointCalls[0].sourceSessionId, /^fuli-remote-/);
  for (const [field, value] of [
    ['personalProjectId', 'forged-project'],
    ['personalSpaceId', 'forged-space'],
    ['projectPath', '/forged/project'],
    ['sessionId', 'forged-session'],
    ['sourceApplication', 'cursor']
  ]) {
    const forgedCheckpoint = await client.callTool({
      name: 'checkpoint_task_knowledge',
      arguments: {
        taskContextToken: 'synthetic-token',
        disposition: 'retain_nothing',
        reason: 'Nothing durable changed.',
        [field]: value
      }
    });
    assert.equal(forgedCheckpoint.isError, true, `${field} crossed the strict checkpoint schema`);
    assert.equal(checkpointCalls.length, 1);
  }

  const verification = await client.callTool({
    name: 'verify_task_checkpoint',
    arguments: { sessionId: 'forged-session' }
  });
  assert.equal(verification.isError, undefined, JSON.stringify(verification));
  assert.equal(verificationCalls.length, 1);
  assert.equal(verificationCalls[0].sessionId, verificationCalls[0].sourceSessionId);
  assert.match(verificationCalls[0].sourceSessionId, /^fuli-remote-/);

  const crossRoleMemory = await client.callTool({
    name: 'get_project_agent_memory',
    arguments: {
      personalSpaceId: 'space-1', personalProjectId: 'project-1',
      agentId: 'agent-2'
    }
  });
  assert.equal(crossRoleMemory.isError, true,
    'remote memory reads must stay bound to the task-selected role');
  assert.equal(boundCalls.has('get_project_agent_memory'), false);

  const bindingCases = [
    ['begin_task_context', {
      sessionId: 'forged-session', projectPath: '/forged/project',
      personalProjectId: 'forged-project', taskPrompt: 'Restore the role.'
    }, { projectPath: null, personalProjectId: 'project-1', personalSpaceId: undefined }],
    ['search_current_project_knowledge', {
      projectPath: '/forged/project', personalProjectId: 'forged-project', queries: ['milestone']
    }, { projectPath: null, personalProjectId: 'project-1', personalSpaceId: undefined }],
    ['get_project_agent_context', {
      projectPath: '/forged/project', agentId: 'agent-1', queries: ['milestone']
    }, { projectPath: null, personalProjectId: 'project-1', personalSpaceId: 'space-1' }],
    ['get_project_agent_memory', {
      personalSpaceId: 'forged-space', personalProjectId: 'forged-project', agentId: 'agent-1'
    }, { personalProjectId: 'project-1', personalSpaceId: 'space-1' }],
    ['view_project_agent_activity', {
      personalSpaceId: 'forged-space', agentId: 'agent-1'
    }, { personalProjectId: 'project-1', personalSpaceId: 'space-1' }],
    ['view_project_agent_task', {
      personalSpaceId: 'forged-space', taskId: 'task-1'
    }, { personalProjectId: 'project-1', personalSpaceId: 'space-1' }]
  ];
  for (const [name, arguments_, expected] of bindingCases) {
    const call = await client.callTool({ name, arguments: arguments_ });
    assert.equal(call.isError, undefined, `${name}: ${JSON.stringify(call)}`);
    const received = boundCalls.get(name);
    assert.ok(received, `${name} was not invoked`);
    for (const [field, value] of Object.entries(expected)) assert.equal(received[field], value);
  }
  for (const name of [
    'begin_task_context',
    'get_collaboration_preferences',
    'search_current_project_knowledge'
  ]) {
    const arguments_ = name === 'begin_task_context'
      ? { sessionId: 'forged', projectPath: '.', taskPrompt: 'x', personalSpaceId: 'forged-space' }
      : name === 'get_collaboration_preferences'
        ? { sessionId: 'forged', projectPath: '.', personalSpaceId: 'forged-space' }
        : { projectPath: '.', queries: ['x'], personalSpaceId: 'forged-space' };
    const rejected = await client.callTool({ name, arguments: arguments_ });
    assert.equal(rejected.isError, true, `${name} accepted an unbound personalSpaceId`);
  }
});

test('remote MCP maps malformed and oversized JSON to client errors', async (t) => {
  const remote = await startRemote();
  t.after(() => remote.close());
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };

  const malformed = await fetch(`${remote.url}/mcp`, {
    method: 'POST', headers, body: '{'
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);

  const oversized = await fetch(`${remote.url}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ ...initializeBody(2), padding: 'x'.repeat(1024 * 1024) })
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, -32600);
});

test('remote MCP rejects an oversized trickle before the client finishes uploading', {
  timeout: 2_000
}, async (t) => {
  const remote = await startRemote();
  t.after(() => remote.close());
  const responsePromise = new Promise((resolve, reject) => {
    const request = httpRequest(`${remote.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'content-length': 2 * 1024 * 1024
      }
    }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        connection: response.headers.connection,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.on('error', reject);
    request.write(Buffer.alloc(1024 * 1024 + 1, 0x20));
  });
  const response = await responsePromise;
  assert.equal(response.status, 413);
  assert.equal(response.connection, 'close');
  assert.equal(response.body.error.code, -32600);
});

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
  await client.connect(transport);
  t.after(() => client.close());
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

test('remote MCP evicts abandoned sessions after the idle TTL', async (t) => {
  const remote = await startRemote({
    sessionIdleTtlMs: 20,
    sessionSweepIntervalMs: 5
  });
  t.after(() => remote.close());
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-session-ttl-test', version: '1.0.0' });
  await client.connect(transport);
  assert.equal(remote.stats().activeSessions, 1);
  await client.close();
  await delay(80);
  assert.equal(remote.stats().activeSessions, 0);
});

test('remote MCP idle-evicts a silent session even with an open SSE stream', {
  timeout: 5_000
}, async (t) => {
  const remote = await startRemote({
    sessionIdleTtlMs: 100,
    sessionSweepIntervalMs: 10
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
  await initialized.body?.cancel();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await delay(40);
    const probe = await fetch(`${remote.url}/mcp`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-06-18'
      }
    });
    await probe.body?.cancel();
  }
  assert.equal(remote.stats().activeSessions, 0);
});

test('remote MCP accepts a session TTL shorter than the normal sweep interval', async (t) => {
  const remote = await startRemote({ sessionIdleTtlMs: 10_000 });
  t.after(() => remote.close());
  assert.equal(remote.stats().activeSessions, 0);
});

test('remote MCP does not idle-evict a long-running tool response', async (t) => {
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
    sessionIdleTtlMs: 20,
    sessionSweepIntervalMs: 5
  });
  t.after(() => remote.close());
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-long-call-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const call = client.callTool({
    name: 'get_collaboration_preferences',
    arguments: { sessionId: 'remote', projectPath: '.' }
  });
  await started.promise;
  await delay(60);
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
  await firstClient.connect(firstTransport);
  assert.equal(remote.stats().activeSessions, 1);

  await firstClient.close();
  await delay(10);
  clock += 1_001;
  const secondTransport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const secondClient = new Client({ name: 'fuli-expired-slot-two', version: '1.0.0' });
  await secondClient.connect(secondTransport);
  t.after(() => secondClient.close());
  assert.equal(remote.stats().activeSessions, 1);
  await firstClient.close().catch(() => {});
});

test('remote MCP re-resolves a session evicted while a POST body is uploading', {
  timeout: 5_000
}, async (t) => {
  let clock = 1_000;
  const remote = await startRemote({
    sessionIdleTtlMs: 20,
    sessionSweepIntervalMs: 5,
    now: () => clock
  });
  t.after(() => remote.close());
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-upload-eviction-test', version: '1.0.0' });
  await client.connect(transport);
  const sessionId = transport.sessionId;
  await client.close();
  const body = `${' '.repeat(1024)}${JSON.stringify({
    jsonrpc: '2.0', id: 77, method: 'tools/list', params: {}
  })}`;
  const splitAt = Math.floor(body.length / 2);
  const responsePromise = new Promise((resolve, reject) => {
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
    }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.on('error', reject);
    request.write(body.slice(0, splitAt));
    setTimeout(() => {
      clock += 1_000;
      setTimeout(() => request.end(body.slice(splitAt)), 20);
    }, 10);
  });
  const response = await responsePromise;
  assert.equal(response.status, 404);
  assert.equal(response.body.error.message, 'Invalid or missing MCP session');
  assert.equal(remote.stats().activeSessions, 0);
});

test('remote MCP independently rejects a caller-controlled Host', async (t) => {
  const remote = await startRemote();
  t.after(() => remote.close());
  const rejected = await rawJsonRequest(`${remote.url}/mcp`, initializeBody(), {
    host: 'attacker.example',
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json'
  });
  assert.equal(rejected.status, 403);

  const admitted = await rawJsonRequest(`${remote.url}/mcp`, initializeBody(), {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json'
  });
  assert.equal(admitted.status, 406);
});

test('remote MCP accepts the requested localhost authority after name resolution', async (t) => {
  const remote = await startRemote({ host: 'localhost' });
  t.after(() => remote.close());
  const port = remote.server.address().port;
  const admitted = await rawJsonRequest(`${remote.url}/mcp`, initializeBody(), {
    host: `localhost:${port}`,
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json'
  });
  assert.equal(admitted.status, 406);
});

test('remote MCP accepts only explicitly configured proxy Host and Origin values', async (t) => {
  const remote = await startRemote({
    allowedHosts: ['connector.example'],
    allowedOrigins: ['https://connector.example']
  });
  t.after(() => remote.close());
  const admitted = await rawJsonRequest(`${remote.url}/mcp`, initializeBody(), {
    host: 'connector.example',
    origin: 'https://connector.example',
    authorization: `bearer ${TOKEN}`,
    'content-type': 'application/json'
  });
  assert.equal(admitted.status, 406);

  const wrongOrigin = await rawJsonRequest(`${remote.url}/mcp`, initializeBody(), {
    host: 'connector.example',
    origin: 'https://other.example',
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json'
  });
  assert.equal(wrongOrigin.status, 403);
});

test('remote MCP rejects unsafe allowed Origin and Host configuration', async () => {
  for (const origin of [
    'http://connector.example',
    'https://user:secret@connector.example',
    'https://connector.example/path',
    'https://connector.example/?query=1',
    'not a URL'
  ]) {
    await assert.rejects(() => startRemote({ allowedOrigins: [origin] }), /allowed origin/i);
  }
  for (const host of [
    'https://connector.example',
    'user@connector.example',
    'connector.example/path',
    'connector.example?query=1',
    'not a host'
  ]) {
    await assert.rejects(() => startRemote({ allowedHosts: [host] }), /allowed host/i);
  }
});

test('remote MCP absorbs and exposes post-listen server errors', async () => {
  const remote = await startRemote();
  const expected = Object.assign(new Error('synthetic post-listen server error'), {
    code: 'EMFILE'
  });
  try {
    assert.doesNotThrow(() => remote.server.emit('error', expected));
    assert.equal(remote.lastServerError(), expected);
  } finally {
    await remote.close();
  }
});

test('remote MCP rejects an initialization that finishes connecting after shutdown starts', {
  timeout: 5_000
}, async () => {
  const connectStarted = Promise.withResolvers();
  const releaseConnect = Promise.withResolvers();
  const remote = await startRemote({
    createMcp: () => ({
      connect: async () => {
        connectStarted.resolve();
        await releaseConnect.promise;
      },
      close: async () => {}
    })
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
}, async () => {
  const dispatchStarted = Promise.withResolvers();
  const releaseDispatch = Promise.withResolvers();
  const remote = await startRemote({
    shutdownGraceMs: 250,
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
}, async () => {
  const connectStarted = Promise.withResolvers();
  const releaseConnect = Promise.withResolvers();
  const dispatchStarted = Promise.withResolvers();
  const releaseDispatch = Promise.withResolvers();
  const remote = await startRemote({
    shutdownGraceMs: 250,
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
  request.on('error', () => {});
  request.end(body);
  await connectStarted.promise;
  request.destroy();
  await delay(25);
  releaseConnect.resolve();
  await dispatchStarted.promise;
  const startedAt = Date.now();
  const closing = remote.close();
  releaseDispatch.resolve();
  await closing;
  assert.ok(
    Date.now() - startedAt < 200,
    'a previously closed response held the in-flight counter until the shutdown deadline'
  );
});

test('remote MCP removes an initialized session whose response was not delivered', {
  timeout: 5_000
}, async () => {
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
  request.on('error', () => {});
  request.end(body);
  try {
    await connectStarted.promise;
    request.destroy();
    await delay(25);
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
}, async () => {
  let clock = 1_000;
  const callStarted = Promise.withResolvers();
  const releaseCall = Promise.withResolvers();
  const callFinished = Promise.withResolvers();
  const remote = await startRemote({
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
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-aborted-call-test', version: '1.0.0' });
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
  request.on('error', () => {});
  request.on('response', response => response.resume());
  request.end(body);
  try {
    await callStarted.promise;
    request.destroy();
    await delay(25);
    clock = 1_500;
    releaseCall.resolve();
    await callFinished.promise;
    await delay(20);
    clock = 2_101;
    await delay(30);
    assert.equal(remote.stats().activeSessions, 0);
  } finally {
    releaseCall.resolve();
    await remote.close();
  }
});

test('remote MCP bounds shutdown even when a client trickles a request body', async () => {
  const remote = await startRemote({ shutdownGraceMs: 20 });
  const body = JSON.stringify(initializeBody());
  const request = httpRequest(`${remote.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    }
  });
  request.on('error', () => {});
  request.write(body.slice(0, 8));
  await delay(5);
  const startedAt = Date.now();
  await remote.close();
  assert.ok(Date.now() - startedAt < 500, 'shutdown exceeded its connection grace period');
  request.destroy();
});

test('remote MCP lets an in-flight tool response finish within shutdown grace', {
  timeout: 5_000
}, async () => {
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
    shutdownGraceMs: 250
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-shutdown-drain-test', version: '1.0.0' });
  await client.connect(transport);
  const call = client.callTool({
    name: 'get_collaboration_preferences',
    arguments: { sessionId: 'remote', projectPath: '.' }
  });
  await started.promise;
  const closing = remote.close();
  await delay(25);
  release.resolve();
  const result = await call;
  assert.equal(result.isError, undefined, JSON.stringify(result));
  await closing;
  await client.close().catch(() => {});
});

test('remote MCP absorbs synchronous session-close failures', async () => {
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
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-close-failure-test', version: '1.0.0' });
  await client.connect(transport);
  await remote.close();
  await client.close().catch(() => {});
});

test('remote MCP bounds shutdown when a session close never settles', {
  timeout: 2_000
}, async () => {
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
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-hung-close-test', version: '1.0.0' });
  await client.connect(transport);
  const startedAt = Date.now();
  const outcome = await Promise.race([
    remote.close().then(() => 'closed'),
    delay(500, 'timed-out')
  ]);
  await client.close().catch(() => {});
  if (outcome !== 'closed') {
    remote.server.closeAllConnections?.();
    remote.server.close();
  }
  assert.equal(outcome, 'closed');
  assert.ok(Date.now() - startedAt < 500, 'session close exceeded the shutdown deadline');
});

test('remote MCP rejects an initialization whose body finishes after shutdown starts', async () => {
  const remote = await startRemote();
  const body = JSON.stringify(initializeBody());
  const splitAt = Math.floor(body.length / 2);
  const responsePromise = new Promise((resolve, reject) => {
    const request = httpRequest(`${remote.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(body)
      }
    }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.on('error', reject);
    request.write(body.slice(0, splitAt));
    setTimeout(() => request.end(body.slice(splitAt)), 20);
  });

  await delay(5);
  const closing = remote.close();
  const response = await responsePromise;
  await closing;
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, -32000);
  assert.deepEqual(remote.stats(), {
    activeSessions: 0,
    pendingSessions: 0,
    closing: true
  });
});

function rawJsonRequest(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-length': Buffer.byteLength(JSON.stringify(body))
      }
    }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          body: text ? JSON.parse(text) : null
        });
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}
