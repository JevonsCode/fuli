// rec#146 item 4: a task the Stop hook closes used to be titled "Auto-closed
// by the Stop hook…", which told the person nothing about the turn. Synthetic
// transcript records only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { turnTitle } from '../src/conversations/turn-title.js';
import { AUTO_CLOSE_SUMMARY, stopHookOutcome } from '../src/conversations/stop-auto-close.js';

let id = 0;
const call = (name, input) => {
  id += 1;
  return { kind: 'tool_call', content: JSON.stringify({ call_id: `c${id}`, name, input }) };
};
const bash = command => call('Bash', { command });
const edit = path => call('Edit', { file_path: path });

test('a turn that changed one file and ran a check says so', () => {
  assert.equal(turnTitle([edit('/synthetic/project/src/export.js'), bash('npm test')]),
    'Changed export.js, ran npm test');
});

test('several files are counted with the first of them named', () => {
  const records = ['alpha.js', 'beta.js', 'gamma.js', 'delta.js'].map(name => edit(`/synthetic/project/src/${name}`));
  assert.equal(turnTitle(records), 'Changed 4 files (alpha.js, beta.js…)');
});

test('only the base name is kept: where the project lives is nobody\'s knowledge', () => {
  const title = turnTitle([edit('/synthetic/home/someone/work/project/src/export.js')]);
  assert.equal(title, 'Changed export.js');
  assert.equal(title.includes('someone'), false);
});

test('a run of scripts names the first two, without repeats', () => {
  assert.equal(turnTitle([bash('npm run typecheck:web && npm test'), bash('npm test'), bash('npm run build:web')]),
    'ran npm run typecheck:web, npm test');
});

test('a turn that only read things, or whose records say nothing, has no title', () => {
  assert.equal(turnTitle([call('Read', { file_path: '/synthetic/project/README.md' }), bash('cat package.json')]), null);
  assert.equal(turnTitle([]), null);
  assert.equal(turnTitle(undefined), null);
  assert.equal(turnTitle([{ kind: 'tool_call', content: 'not json' }]), null);
  assert.equal(turnTitle([{ kind: 'tool_result', content: '{}' }]), null);
});

test('a long line is cut at a whole word', () => {
  const records = Array.from({ length: 9 }, (_, index) => edit(`/synthetic/project/src/a-rather-long-name-${index}.js`));
  const title = turnTitle([...records, bash('npm run typecheck:web')]);
  assert.ok(title.length <= 56, `${title.length} chars`);
  assert.match(title, /…$/);
});

test('the Stop hook puts the title first and keeps the honest reason after it', async () => {
  const sent = [];
  const check = { decision: 'block', reason: 'x', task_context_token: 't', entry_via: 'hook' };
  const source = { sourceApplication: 'claude_code', sourceSessionId: 's' };
  await stopHookOutcome(check, async (name, input) => { sent.push(input); }, source,
    { turn: () => [edit('/synthetic/project/src/export.js')] });
  // The Provider titles a task by the first line of its work summary.
  assert.deepEqual(sent[0].workLog.summary.split('\n'), ['Changed export.js', AUTO_CLOSE_SUMMARY]);
  assert.equal(sent[0].reason, AUTO_CLOSE_SUMMARY, 'why it was auto-closed stays in the reason');
  sent.length = 0;
  // A turn whose records say nothing keeps the one honest sentence it had.
  await stopHookOutcome(check, async (name, input) => { sent.push(input); }, source, { turn: () => [] });
  assert.equal(sent[0].workLog.summary, AUTO_CLOSE_SUMMARY);
});
