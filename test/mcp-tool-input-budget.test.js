import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { listAgentTools } from '../src/agent-tools.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { assertToolInputWithinBudget, createToolInputValidator } from '../src/mcp/tool-input-budget.js';

const ELEMENT_CAP = 50_000;
const DEPTH_CAP = 32;

async function connectedServer(toolProfile = 'full') {
  const calls = [];
  const server = createMcpServer({
    getCollaborationPreferences: async (input) => {
      calls.push(input);
      return { effective_preferences: [] };
    }
  }, {
    env: {},
    registerResources: false,
    ...(toolProfile === 'chat' ? { toolProfile } : { toolNames: ['get_collaboration_preferences', 'checkpoint_task_knowledge'] })
  });
  const client = new Client({ name: 'tool-input-budget-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    calls,
    client,
    async close() {
      await client.close();
      await server.close();
    }
  };
}

function nested(depth) {
  let value = 'leaf';
  for (let level = 0; level < depth; level += 1) value = { next: value };
  return value;
}

async function assertInvalidParams(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, ErrorCode.InvalidParams);
    assert.match(error.message, pattern);
    return true;
  });
}

const normalCall = {
  name: 'get_collaboration_preferences',
  arguments: { projectPath: '/synthetic/project' }
};

test('over-budget tool arguments are rejected as invalid params and the server keeps serving', async () => {
  const mcp = await connectedServer();
  try {
    await assertInvalidParams(mcp.client.callTool({
      name: 'get_collaboration_preferences',
      arguments: { projectPath: '/synthetic/project', requiredCapabilities: Array(ELEMENT_CAP).fill('x') }
    }), new RegExp(`more than the maximum of ${ELEMENT_CAP} elements`));
    await assertInvalidParams(mcp.client.callTool({
      name: 'get_collaboration_preferences',
      arguments: { projectPath: '/synthetic/project', workKind: nested(DEPTH_CAP) }
    }), new RegExp(`deeper than the maximum of ${DEPTH_CAP} levels`));
    assert.equal(mcp.calls.length, 0);

    const result = await mcp.client.callTool(normalCall);
    assert.equal(result.isError, undefined);
    assert.equal(mcp.calls.length, 1);
  } finally { await mcp.close(); }
});

test('fuli_call input is budgeted before dispatch', async () => {
  const mcp = await connectedServer('chat');
  try {
    await assertInvalidParams(mcp.client.callTool({
      name: 'fuli_call',
      arguments: { toolName: 'get_collaboration_preferences', input: { projectPath: nested(DEPTH_CAP) } }
    }), /deeper than the maximum/);
    assert.equal(mcp.calls.length, 0);
    const result = await mcp.client.callTool({
      name: 'fuli_call',
      arguments: { toolName: normalCall.name, input: normalCall.arguments }
    });
    assert.equal(result.isError, undefined);
    assert.equal(mcp.calls.length, 1);
  } finally { await mcp.close(); }
});

test('the budget walk stops at the first element or level past a cap', () => {
  let reads = 0;
  const huge = new Proxy(new Array(10_000_000), {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/u.test(key)) reads += 1;
      return key === 'length' ? target.length : 0;
    }
  });
  assert.throws(() => assertToolInputWithinBudget({ items: huge }), /more than the maximum/);
  assert.ok(reads <= ELEMENT_CAP, `read ${reads} items`);

  let visits = 0;
  const endless = {};
  const cycle = new Proxy(endless, { get() { visits += 1; return cycle; }, ownKeys: () => ['next'],
    getOwnPropertyDescriptor: () => ({ value: cycle, enumerable: true, configurable: true }) });
  assert.throws(() => assertToolInputWithinBudget({ cycle }), /deeper than the maximum/);
  assert.ok(visits <= DEPTH_CAP, `visited ${visits} levels`);
});
// Builds the largest input each schema allows: every optional property set,
// every array at maxItems, and a few members in each open object. Every
// primitive is `leaf`.
const OPEN_OBJECT_MEMBERS = 8;
function largestInput(schema, leaf = 'x') {
  const types = [schema.type].flat();
  if (types.includes('array')) {
    return Array.from({ length: schema.maxItems ?? 1 }, () => largestInput(schema.items, leaf));
  }
  if (!types.includes('object')) return leaf;
  const value = Object.fromEntries(Object.entries(schema.properties ?? {})
    .map(([key, property]) => [key, largestInput(property, leaf)]));
  if (schema.additionalProperties !== false) {
    for (let index = 0; index < OPEN_OBJECT_MEMBERS; index += 1) value[`extra${index}`] = leaf;
  }
  return value;
}

const toolSchema = (name) => listAgentTools().find((definition) => definition.name === name).inputSchema;

test('the largest input every Fuli tool schema allows stays within the budget', () => {
  for (const definition of listAgentTools()) {
    const input = largestInput(definition.inputSchema);
    assert.doesNotThrow(() => assertToolInputWithinBudget(input), definition.name);
    assert.doesNotThrow(
      () => assertToolInputWithinBudget({ toolName: definition.name, input }),
      `fuli_call ${definition.name}`
    );
  }
});

const checkpointBase = { taskContextToken: 'synthetic-token', disposition: 'capture_candidates', reason: 'r' };

test('over-long arrays inside the budget are rejected before validation can exhaust the stack', async () => {
  const mcp = await connectedServer();
  try {
    // 25,000 invalid entities overflowed zod's issue collection; 49,994 is at the element cap.
    for (const count of [25_000, ELEMENT_CAP - 6]) {
      await assertInvalidParams(mcp.client.callTool({
        name: 'checkpoint_task_knowledge',
        arguments: { ...checkpointBase, capture: { entities: Array(count).fill({}) } }
      }), /arguments\.capture\.entities has more than the maximum of 128 items/);
      assert.equal((await mcp.client.callTool(normalCall)).isError, undefined);
    }
  } finally { await mcp.close(); }
});

test('the most invalid input the schema lengths allow returns a bounded validation error', async () => {
  const mcp = await connectedServer();
  try {
    const result = await mcp.client.callTool({
      name: 'checkpoint_task_knowledge',
      arguments: largestInput(toolSchema('checkpoint_task_knowledge'), true)
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'validation');
    assert.ok(result.structuredContent.error.validationErrors.length <= 5);
    assert.equal((await mcp.client.callTool(normalCall)).isError, undefined);
  } finally { await mcp.close(); }
});

test('a stack overflow during validation becomes an invalid-params error', async () => {
  const validator = createToolInputValidator(toolSchema('get_collaboration_preferences'));
  const input = { get projectPath() { throw new RangeError('Maximum call stack size exceeded'); } };
  await assertInvalidParams(validator.parse(input), /too large to validate/);
});
