// rec#146 item 6: a receipt said "你的 70 条习惯" while the entry had handed the
// assistant eight of them. A frame that leaves preferences out says what it
// actually carried and what can still be read. Synthetic receipts only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withDeliveredHabits } from '../src/conversations/entry-habits-line.js';

const LINK = '[看看是哪几条](http://192.0.2.7:2727/habits/0123456789abcdef)';
const prepared = count => `FULI 习惯：这个新对话为你准备了 ${count} 条习惯 · ${count} habits ready for this conversation · ${LINK}`;
const entry = (inline, omitted, lines) => ({
  effective_preferences: Array.from({ length: inline }, (_, index) => ({ preference_key: `rule-${index}` })),
  ...(omitted === null ? {} : { preferences_omitted: { count: omitted } }),
  agent_receipt: { required: true, markdown: 'FULI Agent：合成负责人', lines }
});

test('a bounded frame replaces the habits sentence with the two numbers it can see', () => {
  const value = withDeliveredHabits(entry(8, 62, [prepared(70)]));
  assert.deepEqual(value.agent_receipt.lines,
    [`FULI 习惯：这个新对话直接带上 8 条习惯，另外 62 条可以随时读 · 8 habits carried here, 62 more on request · ${LINK}`]);
  // Only that sentence changes: the link and the identity line stay as they were.
  assert.ok(value.agent_receipt.lines[0].endsWith(LINK));
  assert.equal(value.agent_receipt.markdown, 'FULI Agent：合成负责人');
  assert.equal(value.agent_receipt.required, true);
});

test('a frame that leaves nothing out is unchanged, and so is one without a habits line', () => {
  const whole = entry(8, null, [prepared(8)]);
  assert.equal(withDeliveredHabits(whole), whole);
  const zero = entry(8, 0, [prepared(8)]);
  assert.equal(withDeliveredHabits(zero), zero);
  const other = entry(0, 5, ['FULI 沉淀：合成记录 · 看看']);
  assert.equal(withDeliveredHabits(other), other);
  const noReceipt = { effective_preferences: [], preferences_omitted: { count: 5 } };
  assert.equal(withDeliveredHabits(noReceipt), noReceipt);
  assert.equal(withDeliveredHabits(undefined), undefined);
});

test('a frame that carries none of them says zero, not the resolved count', () => {
  const value = withDeliveredHabits(entry(0, 70, ['FULI 沉淀：合成记录', prepared(70)]));
  assert.equal(value.agent_receipt.lines[0], 'FULI 沉淀：合成记录');
  assert.match(value.agent_receipt.lines[1], /直接带上 0 条习惯，另外 70 条可以随时读/);
  assert.match(value.agent_receipt.lines[1], /0 habits carried here, 70 more on request/);
});

test('a habits line without a link keeps its shape', () => {
  const value = withDeliveredHabits(entry(2, 3, ['FULI 习惯：这个新对话为你准备了 5 条习惯 · 5 habits ready for this conversation']));
  assert.equal(value.agent_receipt.lines[0],
    'FULI 习惯：这个新对话直接带上 2 条习惯，另外 3 条可以随时读 · 2 habits carried here, 3 more on request');
});
