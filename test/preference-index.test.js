// rec#137, rec#111: an entry bounded to a host's inline limit names every
// preference it leaves out, and a preference that states its own scope in
// prose carries that scope as a field instead of only inside its body.
// Synthetic preferences and prompts only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { preferenceIndex, preferenceIndexLine, statedPreferenceScope, statedScopeMeetsTask }
  from '../src/conversations/preference-index.js';

const item = (key, instruction) => ({ preference_key: key, preference_scope: 'global', instruction });

test('a prose-stated scope is lifted out of the instruction, in Chinese and English', () => {
  assert.equal(statedPreferenceScope('仅适用于合成结算需求：地区只按 locale 判断。'), '合成结算需求');
  assert.equal(statedPreferenceScope('只适用于合成报表，不要推断时区'), '合成报表');
  assert.equal(statedPreferenceScope('Only for synthetic timesheet work: round to half an hour.'),
    'synthetic timesheet work');
  assert.equal(statedPreferenceScope('Applies only to synthetic release notes; keep them short.'),
    'synthetic release notes');
});

test('an unrestricted instruction states no scope, and a session clause is left to the session reader', () => {
  assert.equal(statedPreferenceScope('地区只按 locale 判断。'), null);
  assert.equal(statedPreferenceScope('Keep the cursor stable across pages.'), null);
  assert.equal(statedPreferenceScope(''), null);
  assert.equal(statedPreferenceScope(undefined), null);
  // preference-task-scope.js already reads an anchored session clause.
  assert.equal(statedPreferenceScope('仅在 Codex 会话 00000000-0000-4000-8000-000000000000 中：用英文回复'), null);
});

test('an index line is the key, the opening of the instruction and the stated scope', () => {
  assert.equal(preferenceIndexLine(item('locale', '仅适用于合成结算需求：地区只按 locale 判断，不要用时区推断。')),
    'locale — 仅适用于合成结算需求：地区只按 locale 判断，不要用时区推断。 · 仅适用于 合成结算需求');
  // A longer body is cut, so an index of a large set stays cheap.
  assert.match(preferenceIndexLine(item('long', `合成规则：${'先确认字段的单位再改。'.repeat(6)}`)), /…$/);
  const plain = preferenceIndexLine(item('cursor', 'Keep the cursor stable across pages of the synthetic export.'));
  assert.equal(plain, 'cursor — Keep the cursor stable across pages…');
  assert.equal(plain.includes('仅适用于'), false);
});

test('the index names exactly what the frame leaves out, in the order they were resolved', () => {
  const items = ['a', 'b', 'c', 'd'].map((key, index) => item(key, `SYNTHETIC rule ${index + 1}`));
  assert.deepEqual(preferenceIndex(items, new Set([1, 3])),
    ['a — SYNTHETIC rule 1', 'c — SYNTHETIC rule 3']);
  // The keys alone are the cheaper tier for an entry that cannot hold the lines.
  assert.deepEqual(preferenceIndex(items, new Set([1, 3]), 'keys'), ['a', 'c']);
  assert.deepEqual(preferenceIndex(items, new Set([0, 1, 2, 3])), []);
});

test('a stated scope the task never mentions does not meet it; an unrestricted one always does', () => {
  const scoped = item('locale', '仅适用于合成结算需求：地区只按 locale 判断。');
  assert.equal(statedScopeMeetsTask(scoped, '帮我评审这份合成 PRD'), false);
  assert.equal(statedScopeMeetsTask(scoped, '合成结算需求里地区怎么判断？'), true);
  const timesheet = item('hours', 'Only for synthetic timesheet work: round to half an hour.');
  assert.equal(statedScopeMeetsTask(timesheet, 'refactor the synthetic export module'), false);
  assert.equal(statedScopeMeetsTask(timesheet, 'fix the synthetic timesheet rounding'), true);
  // Nothing FULI can place is pushed out by a guess.
  assert.equal(statedScopeMeetsTask(item('plain', 'Keep it short.'), 'anything at all'), true);
  assert.equal(statedScopeMeetsTask(scoped, null), true);
  assert.equal(statedScopeMeetsTask(scoped, '   '), true);
});
