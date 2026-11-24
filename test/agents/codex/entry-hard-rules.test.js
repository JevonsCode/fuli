// #1102 review: hard rules are tried one by one in rank order, so a long one
// never keeps the shorter ones out; one that does not fit even alone is named
// too large. Synthetic entries and preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_CONTEXT_BYTES } from '../../../src/agents/codex/lifecycle-event.js';
import { TOO_LARGE_LABEL } from '../../../src/conversations/entry-inline-budget.js';
import { HARD_RULE_ROOM_STEPS } from '../../../src/conversations/entry-hard-rule-room.js';
import { codexEntrySession, REAL_SCALE_CASE_PROMPT, realScalePreferences, syntheticWorkingEntry }
  from '../../../test-support/synthetic-large-entry.js';

const bytes = text => Buffer.byteLength(text);
const isHard = item => item.preference_qualifiers?.constraint === 'hard';
const LONG = '超长合成硬性规则：提交前先跑相关测试，结果照实写进汇报。';
// The real-scale set with one hard rule made about `size` bytes. Its project-scope
// rule (item 64) ranks first among the hard rules, item 56 last.
const withLong = (position, size) => realScalePreferences().map((item, index) => index === position
  ? { ...item, instruction: LONG.repeat(Math.ceil(size / bytes(LONG))).slice(0, Math.floor(size / 3)) } : item);

async function turns(items, count) {
  return codexEntrySession(async session => {
    const given = new Set();
    const result = [];
    for (let turn = 1; turn <= count; turn++) {
      const { text, frame } = await session.turn(await syntheticWorkingEntry({ items, sessionId: session.sessionId,
        token: `task-${turn}`, sourceApplication: 'codex' }));
      assert.ok(bytes(text) <= CODEX_CONTEXT_BYTES, `turn ${turn}: ${bytes(text)} bytes`);
      for (const item of [...(frame.effective_preferences ?? []), ...(frame.preference_updates ?? [])]) {
        if (isHard(item)) given.add(item.preference_key);
      }
      result.push({ text, frame, given: new Set(given) });
    }
    return result;
  }, { prompt: REAL_SCALE_CASE_PROMPT });
}

for (const [where, position] of [['first', 63], ['second', 7], ['last', 55]]) {
  test(`an 8,000-byte hard rule ranked ${where} is named too large; the other 7 are all given within two turns`, async () => {
    const items = withLong(position, 8000);
    const longKey = items[position].preference_key;
    const others = items.filter(item => isHard(item) && item.preference_key !== longKey).map(item => item.preference_key);
    const [first, second, third] = await turns(items, 3);
    assert.ok(first.given.size >= 5, `${first.given.size} hard rules in the first frame`);
    assert.deepEqual(first.frame.preferences_omitted.too_large, [longKey]);
    assert.ok(first.text.includes(TOO_LARGE_LABEL));
    assert.deepEqual(others.filter(key => !second.given.has(key)), [], 'all 7 given by the second turn');
    assert.equal(second.given.has(longKey), false);
    // Nothing is owed any more: the third frame gives the room back and still names the long one.
    assert.deepEqual(third.frame.preference_updates, []);
    assert.deepEqual(third.frame.preferences_omitted.too_large, [longKey]);
  });
}

test('a 5,700-byte hard rule does not idle a turn: the others come on turn 2, it on turn 3', async () => {
  const items = withLong(63, 5700);
  const [first, second, third] = await turns(items, 3);
  assert.ok(first.given.size >= 5);
  assert.ok(second.given.size > first.given.size, 'turn 2 gives owed rules');
  assert.equal(third.given.size, 8, 'every hard rule given by turn 3');
  assert.equal(third.frame.preferences_omitted?.too_large, undefined);
});

test('a manager keeps its trigger sentence and version when the details give way for hard rules', () => {
  const guidance = { summary: 'Route actionable project work through this manager: read_board before matching or creating items.',
    rules: 'fuli://rules/task-entry/manager_guidance', version: 'synthetic-version' };
  const entry = { context: { personal_project_id: 'project' }, project_management_context: { managers: [{ template_id: 'jefa',
    agent_id: 'employee.jefa', name: 'Jefa', title_mode: 'suggest', personal_project_id: 'project', guidance }] } };
  const reduced = HARD_RULE_ROOM_STEPS.reduce((value, step) => step(value) ?? value, entry);
  const [manager] = reduced.project_management_context.managers;
  assert.deepEqual(manager.guidance, guidance);
  assert.equal(manager.title_mode, undefined, 'the rest gives way to its read');
  assert.equal(manager.read.tool, 'list_employee_tools');
});
