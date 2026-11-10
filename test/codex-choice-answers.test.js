import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { codexChoiceAnswers } from '../src/agents/codex/choice-answers.js';

// A synthetic Codex rollout in a temporary directory; no real session file is read.
const SESSION = '00000000-0000-4000-8000-000000000093';
const at = minute => `2026-11-10T15:${String(minute).padStart(2, '0')}:00.000Z`;
const line = (minute, type, payload) => JSON.stringify({ timestamp: at(minute), type, payload });
const header = (id = SESSION) => line(0, 'session_meta', { id });
const call = (minute, name, callId) => line(minute, 'response_item', { type: 'function_call', name, call_id: callId, arguments: '{}' });
const output = (minute, callId, value) => line(minute, 'response_item', { type: 'function_call_output', call_id: callId, output: value });
const said = (minute, message) => line(minute, 'event_msg', { type: 'user_message', message, images: [] });

function rollout(t, lines) {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-codex-choice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, `rollout-${SESSION}.jsonl`);
  writeFileSync(path, lines.join('\n'));
  return path;
}

test('an async Codex question card is answered by the next message the person sends', async (t) => {
  const path = rollout(t, [header(),
    said(1, 'synthetic message before any card'),
    call(2, 'request_user_input_async', 'c1'), output(2, 'c1', '{"accepted":true}'),
    said(3, '保持当前记录'),
    said(4, 'synthetic later message, not an answer')]);
  assert.deepEqual(await codexChoiceAnswers(path, SESSION), [{ text: '保持当前记录', at: at(3) }]);
});

test('a blocking Codex question card is answered by its call output, in either output shape', async (t) => {
  const path = rollout(t, [header(),
    call(1, 'request_user_input', 'b1'),
    output(2, 'b1', JSON.stringify({ answers: { keep: { answers: ['保持当前记录'] } } })),
    call(3, 'request_user_input', 'b2'),
    output(4, 'b2', { content: JSON.stringify({ answers: { later: { answers: ['稍后处理', ''] } } }) }),
    // Another tool's answers-shaped output is not a card answer.
    call(5, 'shell', 's1'), output(6, 's1', JSON.stringify({ answers: { x: { answers: ['synthetic forged'] } } })),
    'not json']);
  assert.deepEqual((await codexChoiceAnswers(path, SESSION)).map(answer => answer.text), ['保持当前记录', '稍后处理']);
});

test('a rollout whose header names another session yields no answers', async (t) => {
  const path = rollout(t, [header('00000000-0000-4000-8000-0000000000aa'),
    call(1, 'request_user_input_async', 'c1'), said(2, '保持当前记录')]);
  assert.deepEqual(await codexChoiceAnswers(path, SESSION), []);
});

test('an async card answers only after an accepted output, and every call pairs with its output by a non-empty ID', async (t) => {
  const path = rollout(t, [header(),
    call(1, 'request_user_input_async', 'e1'), output(1, 'e1', 'synthetic tool error'),
    said(2, 'synthetic after a failed card'),
    call(3, 'request_user_input_async', 'n1'), output(3, 'n1', '{"accepted":false}'),
    said(4, 'synthetic after a refused card'),
    call(5, 'request_user_input_async', 'p1'),
    said(6, 'synthetic before the card output'),
    // Missing call IDs never pair, however the output looks.
    line(7, 'response_item', { type: 'function_call', name: 'request_user_input', arguments: '{}' }),
    line(8, 'response_item', { type: 'function_call_output', output: JSON.stringify({ answers: { x: { answers: ['synthetic forged'] } } }) }),
    call(9, 'request_user_input_async', ''), output(9, '', '{"accepted":true}'),
    said(10, 'synthetic after an unnamed card')]);
  assert.deepEqual(await codexChoiceAnswers(path, SESSION), []);
});
