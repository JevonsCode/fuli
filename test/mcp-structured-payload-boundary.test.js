import test from 'node:test';
import assert from 'node:assert/strict';

import { LENS_TOOL_DEFINITIONS } from '../src/agent-tools/lens-definitions.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';
import { successToolResult } from '../src/mcp/tool-result.js';

test('successful tool results bound structured JSON without splitting values', () => {
  const result = successToolResult({
    dbPath: 'T:\\private\\context.db',
    store: { secret: true },
    snapshot: { facts: ['private'] },
    summary: 'kept',
    facts: [
      { id: 'fact-1', value: '😀'.repeat(1000) },
      { id: 'fact-2', value: 'later compact fact' }
    ]
  });
  const json = JSON.stringify(result.structuredContent);

  assert.ok(Buffer.byteLength(json, 'utf8') <= 1200);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.content[0].text, json);
  assert.equal(result.structuredContent.summary, 'kept');
  assert.equal(result.structuredContent.facts[0].id, 'fact-1');
  assert.equal(result.structuredContent.truncated, true);
  assert.equal(hasIsolatedSurrogate(result.structuredContent.facts[0].value), false);
  assert.equal(json.includes('context.db'), false);
  assert.equal(json.includes('private'), false);
});

test('lens schemas enforce finite text and retrieval budgets at the MCP boundary', () => {
  const byName = Object.fromEntries(
    LENS_TOOL_DEFINITIONS.map((definition) => [definition.name, definition])
  );
  const lensSchema = byName.get_user_lens.inputSchema;
  const rememberSchema = byName.remember_user_fact.inputSchema;

  assert.equal(lensSchema.properties.task.maxLength, 2048);
  assert.equal(lensSchema.properties.budget.maximum, 16384);
  assert.equal(rememberSchema.properties.value.maxLength, 4096);
  assert.equal(rememberSchema.properties.sourceText.maxLength, 16384);

  const validateLens = jsonSchemaToZod(lensSchema);
  assert.equal(validateLens.safeParse({ task: 'x'.repeat(2049), budget: 1200 }).success, false);
  assert.equal(validateLens.safeParse({ task: 'bounded', budget: 16385 }).success, false);
});

function hasIsolatedSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
