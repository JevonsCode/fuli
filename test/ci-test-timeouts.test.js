import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// A test that never ends must fail the run with its name, not hold a runner for
// hours (a Windows run once waited 3 h 18 min on one file before it was cancelled).
const workflows = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const RUNS_NODE_TESTS = /^\s+(?:- )?run: (?:npm test|npm run test:|node --test)/m;

// Each job of a workflow, as its own block of lines.
function jobs(source) {
  const body = source.split(/^jobs:\n/m)[1] ?? '';
  return [...body.matchAll(/^ {2}([\w-]+):\n((?:(?: {4}.*)?\n)*)/gm)].map(([, name, block]) => ({ name, block }));
}

test('every job that runs the Node tests has a time limit', () => {
  const found = readdirSync(workflows).filter((name) => name.endsWith('.yml')).flatMap((file) =>
    jobs(readFileSync(`${workflows}${file}`, 'utf8')).map((job) => ({ ...job, file })))
    .filter(({ block }) => RUNS_NODE_TESTS.test(block));
  assert.ok(found.some(({ name }) => name === 'node-windows'), 'the jobs are read');
  for (const { file, name, block } of found) {
    const minutes = Number(block.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
    assert.ok(minutes >= 30, `${file} ${name}: timeout-minutes of at least 30`);
  }
});

test('one test that does not end fails with its name, and a handle left open does not keep the run waiting', () => {
  const { scripts } = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.match(scripts['test:node'], /--test-timeout=\d+/);
  assert.match(scripts['test:node'], /--test-force-exit/);
});
