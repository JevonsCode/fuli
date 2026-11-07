import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeTurnRecords } from '../../../src/agents/claude-code/turn-records.js';

const line = value => JSON.stringify({ sessionId: 's-1', ...value });
const withTranscript = (lines, check) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-turn-records-'));
  try {
    const path = join(root, 't.jsonl');
    writeFileSync(path, lines.join('\n'));
    check(path, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('the current turn is the last typed prompt of this session and everything after it', () => {
  withTranscript([
    line({ type: 'user', message: { content: 'first prompt' } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } }] } }),
    line({ type: 'user', message: { content: 'second prompt' } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm run check' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok', is_error: false }] } }),
    line({ type: 'user', message: { content: '<system-reminder>Synthetic mid-turn note.</system-reminder>' } }),
    JSON.stringify({ sessionId: 'other', type: 'user', message: { content: 'not this session' } })
  ], (path, root) => {
    const records = claudeTurnRecords(path, 's-1');
    assert.deepEqual(records.map(record => record.kind), ['message', 'tool_call', 'tool_result', 'message']);
    assert.equal(records[0].content, 'second prompt');
    assert.match(records[1].content, /npm run check/);
    assert.deepEqual(claudeTurnRecords(join(root, 'missing.jsonl'), 's-1'), []);
    assert.deepEqual(claudeTurnRecords(path, null), []);
  });
});

test('a turn the host started keeps its note as the prompt, with the reminders sent beside it', () => {
  withTranscript([
    line({ type: 'user', message: { content: 'typed prompt' } }),
    line({ type: 'user', message: { content: [
      { type: 'text', text: '<side-sessions-event>Synthetic: the side session merged its PR.</side-sessions-event>' },
      { type: 'text', text: '<system-reminder>Synthetic linked-session status.</system-reminder>' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Relayed.' }] } })
  ], path => {
    const records = claudeTurnRecords(path, 's-1');
    assert.deepEqual(records.map(record => record.role), ['user', 'user', 'assistant']);
    assert.match(records[0].content, /side-sessions-event/);
  });
});
