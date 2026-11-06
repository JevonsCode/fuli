import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeTurnRecords } from '../../../src/agents/claude-code/turn-records.js';

test('the current turn is everything after the last typed prompt of this session', () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-turn-records-'));
  try {
    const line = value => JSON.stringify({ sessionId: 's-1', ...value });
    const path = join(root, 't.jsonl');
    writeFileSync(path, [
      line({ type: 'user', message: { content: 'first prompt' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } }] } }),
      line({ type: 'user', message: { content: 'second prompt' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm run check' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok', is_error: false }] } }),
      JSON.stringify({ sessionId: 'other', type: 'user', message: { content: 'not this session' } })
    ].join('\n'));
    const records = claudeTurnRecords(path, 's-1');
    assert.deepEqual(records.map(record => record.kind), ['tool_call', 'tool_result']);
    assert.match(records[0].content, /npm run check/);
    assert.deepEqual(claudeTurnRecords(join(root, 'missing.jsonl'), 's-1'), []);
    assert.deepEqual(claudeTurnRecords(path, null), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
