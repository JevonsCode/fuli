import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listAgentTools } from '../src/agent-tools.js';
import { connectMcp } from '../test-support/mcp-client.js';

test('stdio MCP serves source-backed Personal Lens tools without persisting secrets', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-mcp-protocol-')), 'context.db');
  const first = await connectMcp(dbPath);
  t.after(() => first.close());

  const instructions = first.client.getInstructions();
  assert.match(instructions, /get_user_lens/);
  assert.match(instructions, /remember_user_fact/);
  assert.match(instructions, /submit_user_observation/);
  assert.match(instructions, /never confirm inferred observations/i);
  assert.match(instructions, /query only when needed/i);

  const listed = await first.client.listTools();
  assert.equal(listed.tools.length, 16);
  for (const definition of listAgentTools()) {
    const exposed = tool(listed, definition.name);
    assert.deepEqual(normalizeSchema(exposed.inputSchema), normalizeSchema(definition.inputSchema));
  }
  assert.deepEqual(tool(listed, 'get_user_lens').annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
  assert.equal(tool(listed, 'remember_user_fact').annotations.readOnlyHint, false);
  assert.equal(tool(listed, 'correct_user_fact').annotations.destructiveHint, true);

  const remembered = await first.client.callTool({
    name: 'remember_user_fact',
    arguments: {
      predicate: 'prefers_language',
      value: 'JavaScript',
      sourceText: '我熟悉 JavaScript'
    }
  });
  assert.equal(remembered.isError, undefined);
  assert.equal(remembered.structuredContent.fact.status, 'confirmed');
  assert.equal(remembered.structuredContent.fact.sourceEpisodeId,
    remembered.structuredContent.episode.id);
  assertCompactText(remembered);

  const lens = await first.client.callTool({
    name: 'get_user_lens',
    arguments: { task: 'JavaScript project', budget: 2000 }
  });
  assert.equal(lens.structuredContent.facts.some((fact) =>
    fact.predicate === 'prefers_language' && fact.object === 'JavaScript' &&
    fact.status === 'confirmed' && fact.sourceEpisodeId), true);

  const observed = await first.client.callTool({
    name: 'submit_user_observation',
    arguments: {
      predicate: 'prefers_concise_output',
      value: 'true',
      evidenceText: '连续多次要求简洁输出',
      inference: 'inferred'
    }
  });
  const factId = observed.structuredContent.fact.id;
  const defaultLens = await first.client.callTool({
    name: 'get_user_lens',
    arguments: { task: 'concise output', budget: 2000 }
  });
  const suggestedLens = await first.client.callTool({
    name: 'get_user_lens',
    arguments: { task: 'concise output', budget: 2000, includeSuggested: true }
  });
  assert.equal(defaultLens.structuredContent.facts.some((fact) => fact.id === factId), false);
  assert.equal(suggestedLens.structuredContent.facts.some((fact) => fact.id === factId), true);

  const secret = 'sk-live-12345678901234567890';
  const rejected = await first.client.callTool({
    name: 'remember_user_fact',
    arguments: { predicate: 'credential', value: secret, sourceText: '记住这个凭据' }
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.content[0].text.includes(secret), false);
  assert.equal(JSON.stringify(rejected.structuredContent).includes(secret), false);

  const invalid = await first.client.callTool({
    name: 'get_user_lens',
    arguments: { task: 'test', budget: 1000, unexpectedSecret: secret }
  });
  assert.equal(invalid.isError, true);
  assert.deepEqual(invalid.structuredContent, {
    error: { code: 'validation', message: 'Invalid tool arguments' }
  });
  assert.equal(JSON.stringify(invalid).includes(secret), false);

  const wrongType = await first.client.callTool({
    name: 'get_user_lens',
    arguments: { task: 'test', budget: secret }
  });
  assert.equal(wrongType.isError, true);
  assert.deepEqual(wrongType.structuredContent, {
    error: { code: 'validation', message: 'Invalid tool arguments' }
  });
  assert.equal(JSON.stringify(wrongType).includes(secret), false);

  const unknown = await first.client.callTool({
    name: `unknown-${secret}`,
    arguments: {}
  });
  assert.equal(unknown.isError, true);
  assert.deepEqual(unknown.structuredContent, {
    error: { code: 'internal_error', message: 'Tool execution failed' }
  });
  assert.equal(JSON.stringify(unknown).includes(secret), false);

  const stillUsable = await first.client.callTool({
    name: 'get_user_lens',
    arguments: { task: 'JavaScript project', budget: 2000 }
  });
  assert.equal(stillUsable.isError, undefined);
  assert.equal(stillUsable.structuredContent.facts.some((fact) =>
    fact.predicate === 'prefers_language'), true);

  await first.close();
  const second = await connectMcp(dbPath);
  t.after(() => second.close());
  const afterReconnect = await second.client.callTool({
    name: 'search_user_context',
    arguments: { query: 'credential', includeRestricted: true }
  });
  assert.deepEqual(afterReconnect.structuredContent.facts, []);
  await second.close();
});

function tool(listed, name) {
  return listed.tools.find((candidate) => candidate.name === name);
}

function assertCompactText(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.ok(result.content[0].text.length <= 1200);
}

function normalizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  if (schema.anyOf?.length === 2) {
    const types = schema.anyOf.map((entry) => entry.type).sort();
    if (types[0] === 'null' && types[1] === 'string') return { type: ['string', 'null'] };
  }
  return Object.fromEntries(Object.entries(schema)
    .filter(([key, value]) => key !== '$schema' &&
      !(schema.type === 'integer' && key === 'maximum' && value === Number.MAX_SAFE_INTEGER) &&
      !(schema.type === 'integer' && key === 'minimum' && value === Number.MIN_SAFE_INTEGER))
    .map(([key, value]) => [key, normalizeSchema(value)]));
}
