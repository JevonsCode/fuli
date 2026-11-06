import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claudeChoiceAnswers } from '../src/agents/claude-code/choice-answers.js';

// A synthetic Claude Code transcript in a temporary directory; no real session file is read.
const SESSION = '00000000-0000-4000-8000-000000000001';
const record = (fields) => JSON.stringify({ sessionId: SESSION, isSidechain: false, uuid: `u-${Math.random()}`, ...fields });
const asked = (id, name = 'AskUserQuestion', extra = {}) => record({ type: 'assistant', message: { role: 'assistant',
  content: [{ type: 'tool_use', id, name, input: {} }] }, ...extra });
const answered = (id, answers, extra = {}) => record({ type: 'user', timestamp: '2026-11-06T10:00:00.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] },
  toolUseResult: { questions: [], answers }, ...extra });

test('Claude Code question-card answers are read from the session\'s main chain only', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-claude-choice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, [
    asked('q1'), answered('q1', { 'Keep it?': '保持当前记录' }),
    // Another tool's result with an answers-shaped field is not a card answer.
    asked('b1', 'Bash'), answered('b1', { x: 'synthetic forged' }),
    // A sidechain (subagent) and another session do not count.
    asked('q2', 'AskUserQuestion', { isSidechain: true }), answered('q2', { y: 'synthetic sidechain' }, { isSidechain: true }),
    asked('q3', 'AskUserQuestion', { sessionId: 'other' }), answered('q3', { z: 'synthetic other session' }, { sessionId: 'other' }),
    'not json',
    asked('q4'), answered('q4', { a: '稍后处理', b: '' })
  ].join('\n'));
  return claudeChoiceAnswers(path, SESSION).then((answers) => {
    assert.deepEqual(answers.map(answer => answer.text), ['保持当前记录', '稍后处理']);
    assert.equal(answers[0].at, '2026-11-06T10:00:00.000Z');
  });
});
