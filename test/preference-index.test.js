// rec#137, rec#111: an entry bounded to a host's inline limit names every
// preference it leaves out, and a preference that states the scope it applies
// to in prose carries that scope in its line. Synthetic preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { preferenceIndex, preferenceIndexLine, statedPreferenceScope, statedScopeMeetsProject }
  from '../src/conversations/preference-index.js';

const item = (key, instruction, scope = 'global') => ({ preference_key: key, preference_scope: scope, instruction });

test('a prose-stated scope is lifted out of the instruction, in Chinese and English', () => {
  assert.equal(statedPreferenceScope('仅适用于合成结算需求：地区只按 locale 判断。'), '合成结算需求');
  assert.equal(statedPreferenceScope('只适用于合成报表，不要推断时区'), '合成报表');
  assert.equal(statedPreferenceScope('仅限合成项目：提交前跑全量测试'), '合成项目');
  assert.equal(statedPreferenceScope('Only for synthetic timesheet work: round to half an hour.'), 'synthetic timesheet work');
  assert.equal(statedPreferenceScope('Applies only to synthetic release notes; keep them short.'), 'synthetic release notes');
});

// Review of #1070: these describe when an action may happen, for every task.
// Read as scopes, "只在用户确认后才推送到远端" ranked last on a push task and
// its line said it applied only to that condition — the opposite of the rule.
test('a condition on an action is not a scope', () => {
  assert.equal(statedPreferenceScope('只在用户确认后才推送到远端。'), null);
  assert.equal(statedPreferenceScope('Only when the person confirms, push to the shared remote.'), null);
  assert.equal(statedPreferenceScope('Only on a clean tree, run the release script.'), null);
  assert.equal(statedPreferenceScope('Only in English, write commit messages.'), null);
  assert.equal(preferenceIndexLine(item('push-confirm', '只在用户确认后才推送到远端。')).includes('仅适用于'), false);
});

// Review of #1070: a time or a condition after 仅限 / Only for is not a scope.
test('a time or a condition after a scope word is not a scope', () => {
  assert.equal(statedPreferenceScope('仅限周五发布，其他时间不要发版。'), null);
  assert.equal(statedPreferenceScope('仅限工作日上午部署合成服务。'), null);
  assert.equal(statedPreferenceScope('仅限用户确认后推送到合成远端。'), null);
  assert.equal(statedPreferenceScope('Only for Friday releases: never ship on other days.'), null);
  assert.equal(statedPreferenceScope('Only for deploys after approval, use the synthetic pipeline.'), null);
  // A project or scene name after it still is one.
  assert.equal(statedPreferenceScope('仅限合成支付项目：提交前跑全量测试'), '合成支付项目');
  assert.equal(statedPreferenceScope('Only for synthetic timesheet work: round to half an hour.'), 'synthetic timesheet work');
});

test('an unrestricted instruction states no scope, and a session clause is left to the session reader', () => {
  assert.equal(statedPreferenceScope('地区只按 locale 判断。'), null);
  assert.equal(statedPreferenceScope('Keep the cursor stable across pages.'), null);
  assert.equal(statedPreferenceScope(''), null);
  assert.equal(statedPreferenceScope(undefined), null);
  assert.equal(statedPreferenceScope('仅适用于 Codex 会话 00000000-0000-4000-8000-000000000000：用英文回复'), null);
});

test('an index line is the key, its layer where not global, the opening and the stated scope', () => {
  assert.equal(preferenceIndexLine(item('locale', '仅适用于合成结算需求：地区只按 locale 判断，不要用时区推断。')),
    'locale — 仅适用于合成结算需求：地区只按 locale 判断，不要用时区推断。 · 仅适用于 合成结算需求');
  assert.equal(preferenceIndexLine(item('cursor', 'Keep the cursor stable across pages of the synthetic export.')),
    'cursor — Keep the cursor stable across pages…');
  // The same key at two layers is told apart.
  assert.equal(preferenceIndexLine(item('cursor', 'Keep it stable.', 'project')), 'cursor (project) — Keep it stable.');
  assert.equal(preferenceIndexLine(item('cursor', 'Keep it stable.', 'agent')), 'cursor (agent) — Keep it stable.');
});

test('a cut that drops an exception says the rule has one', () => {
  const line = preferenceIndexLine(item('squash', 'Never squash merge a synthetic branch, except on release branches.'));
  assert.match(line, /^squash — Never squash merge a synthetic bran…/);
  assert.match(line, /有例外，读全文 \/ has exceptions, read in full/);
  assert.match(preferenceIndexLine(item('squash-zh', '合成分支一律不要压缩合并提交记录，以免丢失合成项目里的全部历史记录，除非是发布分支。')), /有例外/);
  // A cut with no exception after it, and an uncut line, say nothing of the kind.
  assert.doesNotMatch(preferenceIndexLine(item('long', 'Keep the cursor stable across pages of the synthetic export.')), /例外/);
  assert.doesNotMatch(preferenceIndexLine(item('short', 'Never, except on Fridays.')), /例外/);
});

test('the index names exactly what the frame leaves out, in the order they were resolved', () => {
  const items = ['a', 'b', 'c', 'd'].map((key, index) => item(key, `SYNTHETIC rule ${index + 1}`));
  assert.deepEqual(preferenceIndex(items, new Set([1, 3])), ['a — SYNTHETIC rule 1', 'c — SYNTHETIC rule 3']);
  assert.deepEqual(preferenceIndex(items, new Set([1, 3]), 'keys'), ['a', 'c']);
  assert.deepEqual(preferenceIndex(items, new Set([0, 1, 2, 3])), []);
});

test('a stated scope is read against the session\'s project, not each prompt', () => {
  const scoped = item('locale', '仅适用于合成结算需求：地区只按 locale 判断。');
  assert.equal(statedScopeMeetsProject(scoped, ['synthetic-review', 'Synthetic Review']), false);
  // Pairs of characters, so the whole run is not required.
  assert.equal(statedScopeMeetsProject(scoped, ['synthetic-billing', '结算需求']), true);
  const project = item('suite', '仅限合成支付项目：提交前跑全量测试');
  assert.equal(statedScopeMeetsProject(project, ['synthetic-payments', '合成支付', 'payments']), true);
  // At least half of a Latin scope's words: unsure gives the rule rather than withholds it.
  const timesheet = item('hours', 'Only for synthetic timesheet work: round to half an hour.');
  assert.equal(statedScopeMeetsProject(timesheet, ['sample-export']), false);
  assert.equal(statedScopeMeetsProject(timesheet, ['synthetic-export']), true);
  assert.equal(statedScopeMeetsProject(timesheet, ['synthetic-timesheet']), true);
});

test('nothing FULI cannot place is pushed out on a guess', () => {
  const scoped = item('locale', '仅适用于合成结算需求：地区只按 locale 判断。');
  assert.equal(statedScopeMeetsProject(item('plain', 'Keep it short.'), ['anything']), true);
  assert.equal(statedScopeMeetsProject(scoped, []), true);
  assert.equal(statedScopeMeetsProject(scoped, [null, undefined, '  ']), true);
});
