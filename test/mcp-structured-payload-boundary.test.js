import test from 'node:test';
import assert from 'node:assert/strict';

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

test('a tool can opt into a larger bounded context result', () => {
  const result = successToolResult({
    effective_preferences: Array.from({ length: 8 }, (_, index) => ({
      instruction: `Apply collaboration preference ${index}: ${'x'.repeat(160)}`,
      preference_key: `preference-${index}`
    }))
  }, { limitBytes: 16 * 1024 });
  const json = JSON.stringify(result.structuredContent);

  assert.ok(Buffer.byteLength(json, 'utf8') > 1200);
  assert.ok(Buffer.byteLength(json, 'utf8') <= 16 * 1024);
  assert.equal(result.structuredContent.truncated, undefined);
  assert.match(
    result.structuredContent.effective_preferences.at(-1).instruction,
    /preference 7/
  );
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
