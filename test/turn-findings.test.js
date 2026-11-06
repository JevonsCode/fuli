import assert from 'node:assert/strict';
import test from 'node:test';
import { turnFindings } from '../src/conversations/turn-findings.js';
import { AUTO_KEEP_REASON, stopHookOutcome } from '../src/conversations/stop-auto-close.js';

let id = 0;
const run = (command, output, isError = false) => {
  id += 1;
  return [{ kind: 'tool_call', content: JSON.stringify({ call_id: `c${id}`, name: 'Bash', input: { command } }) },
    { kind: 'tool_result', content: JSON.stringify({ call_id: `c${id}`, output, is_error: isError }) }];
};
const ENOENT = ['Exit code 1', '> tidewater@0.4.0 test',
  "Error: ENOENT: no such file or directory, open 'C:/Users/someone/work/tidewater/spec/fixtures/messages.json'"].join('\n');

test('a script that failed alone and passed after another names that one as its prerequisite', () => {
  const records = [
    ...run('cat package.json', '{}'),
    ...run('npm test', ENOENT, true),
    ...run('npm run fixtures && npm test 2>&1 | tail -20', 'wrote spec/fixtures/messages.json\n# pass 9'),
    ...run('npm run check', 'ok: 6 error codes listed')
  ];
  const [first, checks] = turnFindings(records, 'Done. Tests pass.');
  assert.equal(first.task, 'Run `npm run fixtures` before `npm test`');
  assert.match(first.solution, /failed until `npm run fixtures` had run \(first error: Error: ENOENT/);
  assert.ok(first.solution.includes("open '…/spec/fixtures/messages.json'"), first.solution);
  assert.doesNotMatch(first.solution, /someone/);
  assert.equal(checks.task, 'Project checks: `npm run check`, `npm run fixtures`, `npm test`');
});

test('refused calls, failed chains and passing-only turns name no prerequisite', () => {
  const denied = 'This Bash command contains multiple operations. The following parts require approval: npm test';
  const records = [
    ...run('npm test; npm run check', denied, true),
    ...run('npm run fixtures; npm test', 'Exit code 1\nfail', true),
    ...run('npm run fixtures && npm test', '# pass 9')
  ];
  const found = turnFindings(records);
  assert.deepEqual(found.map(item => item.task), ['Project checks: `npm run fixtures`, `npm test`']);
  assert.deepEqual(turnFindings([...run('cat a', 'x')]), []);
});

test('a rule the final reply spells out is kept; plain summaries are not', () => {
  const [rule] = turnFindings([], 'I added the webhook channel.\nError codes follow the TW-<AREA>-<NNN> convention: every code must be listed in docs/error-codes.md.');
  assert.match(rule.task, /convention/);
  assert.deepEqual(turnFindings([], 'Added the endpoint and a test. All 22 tests pass.'), []);
});

test('the Stop hook closes with what the turn showed as pending experiences, and without them when refused', async () => {
  const sent = [];
  const check = { decision: 'block', reason: 'x', task_context_token: 't', entry_via: 'hook' };
  const source = { sourceApplication: 'claude_code', sourceSessionId: 's' };
  const experiences = [{ task: 'Run `npm run fixtures` before `npm test`', solution: 'x', searchKeys: ['npm test'] }];
  assert.deepEqual(await stopHookOutcome(check, async (name, input) => { sent.push(input); }, source, { findings: () => experiences }), {});
  assert.equal(sent[0].disposition, 'capture_candidates');
  assert.deepEqual(sent[0].experiences, experiences);
  assert.equal(sent[0].reason, AUTO_KEEP_REASON);
  sent.length = 0;
  await stopHookOutcome(check, async (name, input) => { sent.push(input); if (input.experiences) throw new Error('refused'); },
    source, { findings: () => experiences });
  assert.deepEqual(sent.map(input => input.disposition), ['capture_candidates', 'retain_nothing']);
  sent.length = 0;
  await stopHookOutcome(check, async (name, input) => { sent.push(input); }, source, { findings: () => { throw new Error('unreadable'); } });
  assert.deepEqual(sent.map(input => input.disposition), ['retain_nothing']);
});
