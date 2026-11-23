import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { createRemoteMcpHttpServer } from '../src/mcp/remote-http-server.js';
import { isFetchBlockedPort } from '../src/server/blocked-ports.js';
import {
  TOKEN,
  initializeBody,
  startRemote,
  rawJsonRequest
} from '../test-support/remote-mcp.js';

// The remote MCP HTTP server's door: bearer auth and the binding to one project
// and host session, request bodies, Host and Origin checks, and its port.

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
  t.after(() => client.close());
  await client.connect(transport);

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

test('remote MCP rebinds an ephemeral port that fetch refuses', async (t) => {
  const refused = [];
  const remote = await startRemote({
    isBlockedPort: (port) => {
      if (refused.length === 0) refused.push(port);
      return refused.includes(port) || isFetchBlockedPort(port);
    }
  });
  t.after(() => remote.close());
  assert.equal(refused.length, 1);
  assert.notEqual(new URL(remote.url).port, String(refused[0]));
  const response = await fetch(`${remote.url}/mcp`, { method: 'POST' });
  assert.equal(response.status, 401);
});

test('remote MCP refuses a configured port that fetch refuses', async () => {
  await assert.rejects(() => startRemote({ port: 6000 }), /Port 6000 is blocked for local fetch/);
});

test('remote MCP stops rebinding when every ephemeral port is refused', async () => {
  await assert.rejects(
    () => startRemote({ isBlockedPort: () => true }),
    /No port outside the fetch block list was available after 20 attempts/
  );
});

// Review of #1075: the remote server gives each session's MCP server this installation's name on its
// task tokens (task-issuer.js), as the stdio server does.
test('remote MCP gives each session\'s server this FULI\'s name on its task tokens', async (t) => {
  const seen = [];
  const remote = await startRemote({ taskIssuer: 'ab'.repeat(8), createMcp: (app, options) => {
    seen.push(options.taskIssuer);
    return createMcpServer(app, options);
  } });
  t.after(() => remote.close());
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'fuli-task-issuer-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual(seen, ['ab'.repeat(8)]);
});
