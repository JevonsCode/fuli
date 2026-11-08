// Agent replies FULI kept as knowledge before #839 (seen 2026-11-08) are found
// for 待决策's own group; real knowledge is left alone. Synthetic items only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { hasFuliMarkup } from '../src/graphiti/fuli-markup.js';
import { replyEchoSignals } from '../src/graphiti/reply-echo.js';

const CONSOLE = 'http://127.0.0.1:2828';
const itemUrl = id => `${CONSOLE}/knowledge/project/space-1/directory/entity/${id}`;
const checkpoint = [{ id: 'ep-1', source_kind: 'task_experience', name: 'Reusable experience' }];
// What the Stop hook's reply rule kept: one sentence as both title and solution.
const replyCaptured = (sentence, extra = {}) => ({ id: `e-${sentence.length}`, type: 'ReusableExperience', name: sentence.slice(0, 240),
  summary: sentence.slice(0, 600), attributes: { solution: sentence.slice(0, 600), searchTerms: ['x'] },
  confirmation_status: 'pending', confirmation_basis: { proposed_by: { kind: 'agent', label: 'lead-synthetic' } },
  evidence: checkpoint, ...extra });
const experience = (task, solution, extra = {}) => replyCaptured(task, { name: task, summary: solution,
  attributes: { solution, searchTerms: ['x'] }, ...extra });

test('a reply sentence the Stop hook kept is found by its shape and its words', () => {
  assert.deepEqual(replyEchoSignals(replyCaptured('I moved the npm-copy notice off the top bar; the fix is in PR #842, not merged yet.')),
    ['reply_capture', 'progress_narration', 'status_report']);
  assert.deepEqual(replyEchoSignals(replyCaptured(`The convention is to run checks first [Run checks](${itemUrl('item-a')})`)),
    ['reply_capture', 'fuli_markup']);
  assert.deepEqual(replyEchoSignals(replyCaptured('我已经把通知移到设置页，PR #842 还没合并。')),
    ['reply_capture', 'progress_narration', 'status_report']);
});

test('receipts, FULI links and markdown status reports are found on any pending Agent item', () => {
  const receipt = experience('Release checklist', `I updated the checklist.\nFULI Agent：[Lyn](<fuli://agents/space-1/agent-1>)`);
  assert.deepEqual(replyEchoSignals(receipt), ['fuli_markup', 'progress_narration']);
  const report = experience('Status', '## Done\n- [x] notice moved\n- [ ] PR #842 not merged yet');
  assert.deepEqual(replyEchoSignals(report), ['status_report', 'report_shape']);
  // A checklist alone is a checklist.
  assert.equal(replyEchoSignals(experience('Release checklist', '- [ ] bump the version\n- [ ] tag the release')), null);
  // Two signals agree: a first-person account of a PR's state.
  assert.deepEqual(replyEchoSignals(experience('Top bar notice', 'I fixed the notice; the fix is in PR #842, not merged yet.')),
    ['progress_narration', 'status_report']);
  // Nothing but FULI's own markup is left.
  const onlyLinks = experience(`[Run checks](${itemUrl('item-a')})`, `[Run checks](${itemUrl('item-a')})`);
  assert.deepEqual(replyEchoSignals(onlyLinks), ['reply_capture', 'fuli_markup']);
  assert.deepEqual(replyEchoSignals({ id: 'r-1', fact: 'I merged it. CI is green.', confirmation_status: 'pending' }, 'relationship'),
    ['progress_narration', 'status_report']);
});

test('one signal alone, or real knowledge, stays out', () => {
  // The reply rule's own shape, but a project rule with nothing else of a reply.
  assert.equal(replyEchoSignals(replyCaptured('We always run the migrations before the API tests.')), null);
  assert.equal(replyEchoSignals(replyCaptured('We run the migrations before the API tests.')), null);
  // What the turn's runs verified (turn-findings.js): title and solution differ.
  assert.equal(replyEchoSignals(experience('Run `npm run build` before `npm test`', '`npm test` failed until `npm run build` had run.')), null);
  // A PR number alone, or first person alone, is not enough.
  assert.equal(replyEchoSignals(experience('Release notes', 'Release notes live in PR #842\'s description.')), null);
  assert.equal(replyEchoSignals(experience('Notice', 'I moved the notice to the settings page.')), null);
  // A dev fact that names a fuli:// rule is markup alone.
  assert.equal(replyEchoSignals(experience('Task entry rules', 'Rules are read from fuli://rules/task-entry on demand.')), null);
});

test('the person\'s own and anything no longer waiting are never in the group', () => {
  const echo = 'I moved the notice; the fix is in PR #842, not merged yet.';
  for (const extra of [
    { confirmation_status: 'confirmed' }, { confirmation_status: 'agent_confirmed' }, { invalid_at: '2026-11-08T00:00:00Z' },
    { replaced_by_item_id: 'e-2' }, { human_edited: true }, { profile_aspect: 'judgment_preference' },
    { confirmation_basis: { proposed_by: { kind: 'user' } } }
  ]) assert.equal(replyEchoSignals(replyCaptured(echo, extra)), null, JSON.stringify(extra));
  // An experience from another source does not have the Stop hook's shape.
  assert.equal(replyEchoSignals(replyCaptured('The convention is: links [x](fuli://items/1)', { evidence: [{ source_kind: 'conversation' }] })),
    null);
});

test('hasFuliMarkup tells markup from plain text', () => {
  assert.equal(hasFuliMarkup('Run the fixtures first.'), false);
  assert.equal(hasFuliMarkup('Run the fixtures first.   \n\n\n'), false);
  assert.equal(hasFuliMarkup(`Run [fixtures](${itemUrl('a')}) first.`), true);
  assert.equal(hasFuliMarkup(''), false);
});
