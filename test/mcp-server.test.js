import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import { ApplicationError } from '../src/app/application-error.js';
import { listAgentTools } from '../src/agent-tools.js';
import { annotationsFor } from '../src/mcp/tool-annotations.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';
import { errorToolResult } from '../src/mcp/tool-result.js';
import { createCloseOnce } from '../src/mcp/runtime.js';

test('--tools lists the Graphiti registry without requiring a runtime config', () => {
  const output = execFileSync(process.execPath, ['src/mcp-server.js', '--tools'], {
    encoding: 'utf8'
  });
  assert.deepEqual(JSON.parse(output), listAgentTools());
});

test('strict Zod conversion preserves nested Graphiti arrays and required fields', () => {
  for (const definition of listAgentTools()) {
    const converted = jsonSchemaToZod(definition.inputSchema);
    const valid = sampleValue(definition.inputSchema);
    assert.equal(converted.safeParse(valid).success, true, definition.name);
    assert.equal(converted.safeParse({ ...valid, unexpected: true }).success, false,
      `${definition.name} must reject additional properties`);
    for (const required of definition.inputSchema.required ?? []) {
      const missing = { ...valid };
      delete missing[required];
      assert.equal(converted.safeParse(missing).success, false,
        `${definition.name}.${required} must remain required`);
    }
  }
});

test('MCP annotations distinguish reads, writes, and review decisions', () => {
  for (const { name } of listAgentTools()) {
    assert.deepEqual(Object.keys(annotationsFor(name)).sort(), [
      'destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'
    ]);
  }
  assert.equal(annotationsFor('get_collaboration_preferences').readOnlyHint, false);
  assert.equal(annotationsFor('search_knowledge_graph').readOnlyHint, false);
  assert.equal(annotationsFor('get_knowledge_graph').readOnlyHint, false);
  assert.equal(annotationsFor('search_human_knowledge_changes').readOnlyHint, false);
  assert.equal(annotationsFor('capture_session_knowledge').readOnlyHint, false);
  assert.equal(annotationsFor('capture_session_knowledge').openWorldHint, true);
  assert.equal(annotationsFor('review_project_proposal').destructiveHint, true);
});

test('controlled Provider validation errors keep the actionable reason', () => {
  const result = errorToolResult(new ApplicationError(
    'provider_error',
    'body.episode.entities[0]: non-known-known knowledge requires a reasoning summary'
  ));

  assert.equal(result.structuredContent.error.message,
    'body.episode.entities[0]: ' +
    'non-known-known knowledge requires a reasoning summary');
  assert.equal(result.isError, true);
});

test('close-once runtime closes MCP before the graph facade exactly once', async () => {
  const calls = [];
  const close = createCloseOnce({
    closeServer: async () => calls.push('server'),
    closeApplication: async () => calls.push('graph')
  });
  await Promise.all([close(), close(), close()]);
  assert.deepEqual(calls, ['server', 'graph']);
});

function sampleValue(schema) {
  if (schema.enum) return schema.enum[0];
  if (Array.isArray(schema.type)) return schema.type.includes('string') ? 'value' : null;
  if (schema.type === 'string') {
    return schema.format === 'date-time' ? '2026-07-21T10:00:00.000Z' :
      schema.pattern === '^[A-Z][A-Z0-9_]*$' ? 'RELATES_TO' :
        schema.pattern === '^[A-Za-z][A-Za-z0-9_]*$' ? 'Entity' :
          schema.pattern === '^personal-global-[a-f0-9]{20}$' ?
            'personal-global-0123456789abcdef0123' :
            schema.pattern === '^v1:[a-f0-9]{24}$' ?
              'v1:0123456789abcdef01234567' :
          schema.pattern === '^(entity|relationship):.+' ? 'entity:valid-value' :
          'valid-value';
  }
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer') return Math.max(1, schema.minimum ?? 1);
  if (schema.type === 'number') return schema.minimum ?? 0;
  if (schema.type === 'array') {
    const count = schema.minItems ?? 0;
    return Array.from({ length: count }, () => sampleValue(schema.items));
  }
  if (schema.type === 'object') {
    return Object.fromEntries(Object.entries(schema.properties ?? {})
      .filter(([name]) => (schema.required ?? []).includes(name))
      .map(([name, value]) => [name, sampleValue(value)]));
  }
  throw new Error(`No sample for ${schema.type}`);
}
