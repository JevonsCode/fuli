import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from '../src/mcp/create-mcp-server.js';

test('an explicit empty MCP allowlist creates a valid tool-less server', async () => {
  const server = createMcpServer({}, {
    env: {}, toolNames: [], registerResources: false
  });
  const client = new Client({ name: 'empty-allowlist-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test('tool-less MCP servers report unknown calls as not found', async () => {
  const server = createMcpServer({}, {
    env: {}, toolNames: [], registerResources: false
  });
  const handler = server.server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call', params: { name: 'not_a_fuli_tool', arguments: {} }
  }, { signal: new AbortController().signal, requestId: 1 });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.error, {
    code: 'not_found',
    message: 'Unknown Fuli tool'
  });
  await server.close();
});

test('non-Codex MCP servers never inherit a Codex native thread ID', async () => {
  const nativeThreadId = '019fc6ed-02a5-7832-8821-68e3b03e7ce3';
  let received;
  const server = createMcpServer({
    beginTaskContext: async (input) => {
      received = input;
      return { taskContextToken: 'synthetic-token' };
    }
  }, {
    env: { CODEX_THREAD_ID: nativeThreadId },
    sourceApplication: 'claude_code',
    toolNames: ['begin_task_context'],
    registerResources: false
  });
  const client = new Client({ name: 'source-isolation-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({
      name: 'begin_task_context',
      arguments: { sessionId: 'claude-session', projectPath: '/synthetic/project' }
    });
    assert.equal(received.sessionId, 'claude-session');
    assert.equal(received.sourceApplication, 'claude_code');
    assert.match(received.sourceSessionId, /^fuli-host-/);
    assert.notEqual(received.sourceSessionId, nativeThreadId);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP allowlists reject unknown names instead of silently hiding typos', () => {
  assert.throws(
    () => createMcpServer({}, {
      env: {}, toolNames: ['not_a_fuli_tool'], registerResources: false
    }),
    /Unknown MCP tool.*not_a_fuli_tool/
  );
});

test('custom MCP calls forward request metadata to the runtime lease boundary', async () => {
  const controller = new AbortController();
  const extra = { signal: controller.signal, requestId: 7, sessionId: 'transport-session' };
  let leaseExtra;
  const server = createMcpServer({ listKnowledgeSpaces: async () => [] }, {
    env: {}, toolNames: ['list_knowledge_spaces'], registerResources: false,
    withRuntimeLease: async (_owner, operation, requestExtra) => {
      leaseExtra = requestExtra;
      return operation();
    }
  });
  const handler = server.server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call', params: { name: 'list_knowledge_spaces', arguments: {} }
  }, extra);

  assert.equal(result.isError, undefined);
  assert.equal(leaseExtra, extra);
  await server.close();
});

test('already-cancelled MCP calls never enter a custom runtime lease', async () => {
  let leaseCalls = 0;
  let applicationCalls = 0;
  const server = createMcpServer({
    listKnowledgeSpaces: async () => {
      applicationCalls += 1;
      return [];
    }
  }, {
    env: {}, toolNames: ['list_knowledge_spaces'], registerResources: false,
    withRuntimeLease: async (_owner, operation) => {
      leaseCalls += 1;
      return operation();
    }
  });
  const controller = new AbortController();
  controller.abort(new Error('synthetic cancellation before lease'));
  const handler = server.server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call', params: { name: 'list_knowledge_spaces', arguments: {} }
  }, { signal: controller.signal, requestId: 9 });

  assert.equal(result.isError, true);
  assert.equal(leaseCalls, 0);
  assert.equal(applicationCalls, 0);
  await server.close();
});

test('custom MCP validation reports bounded issue paths without argument values', async () => {
  const server = createMcpServer({}, {
    env: {}, toolNames: ['coordinate_project_agent_task'], registerResources: false
  });
  const handler = server.server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: { name: 'coordinate_project_agent_task', arguments: { personalSpaceId: 'secret-value' } }
  }, { signal: new AbortController().signal, requestId: 8 });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'validation');
  assert.ok(result.structuredContent.error.validationErrors.length > 0);
  assert.match(
    result.structuredContent.error.validationErrors[0].field,
    /projectPath|personalProjectId|objective|workKind|requiredCapabilities/
  );
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  await server.close();
});
