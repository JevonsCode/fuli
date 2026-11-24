import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Every push to a pull request starts each of its workflows again. Without a
// concurrency group the runs for the earlier commits stay in the queue, and the
// commit that can actually be merged waits behind them.
const workflows = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

test('a new push to a pull request cancels the runs for its earlier commit', () => {
  const onPullRequest = readdirSync(workflows)
    .filter(name => name.endsWith('.yml'))
    .map(name => ({ name, source: readFileSync(`${workflows}${name}`, 'utf8') }))
    .filter(({ source }) => /^ {2}pull_request:/m.test(source));
  assert.ok(onPullRequest.length > 0, 'at least one workflow runs on pull requests');
  for (const { name, source } of onPullRequest) {
    const block = source.match(/^concurrency:\n((?: {2}.*\n)+)/m)?.[1] ?? '';
    // Keyed by pull request: two pull requests never cancel each other, and a
    // run with no pull request (main, a manual dispatch) gets a group of its own.
    assert.match(block, /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.run_id \}\}/, name);
    assert.match(block, /cancel-in-progress: true/, name);
  }
});
