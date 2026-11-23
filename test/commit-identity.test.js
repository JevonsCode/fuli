import assert from 'node:assert/strict';
import test from 'node:test';
import { commitsWithPersonalAddress } from '../scripts/check-commit-identity.js';

const line = (commit, author, committer) => [commit, author, committer].join('\t');
const noReply = '1+someone@users.noreply.github.com';

test('a commit passes only when author and committer are both GitHub no-reply addresses', () => {
  assert.deepEqual(commitsWithPersonalAddress([
    line('a1', noReply, noReply),
    // A merge made on github.com, and a bot's commit.
    line('a2', noReply, 'noreply@github.com'),
    line('a3', '41898282+github-actions[bot]@users.noreply.github.com', noReply),
    '',
  ]), []);
});

test('the committer a fresh clone takes from the global config is caught, not only the author', () => {
  assert.deepEqual(commitsWithPersonalAddress([
    line('b1', noReply, 'someone@example.test'),
    line('b2', 'someone@example.test', noReply),
    line('b3', 'someone@example.test', 'someone@example.test'),
    // An address that only contains the no-reply host is not one.
    line('b4', noReply, 'x@users.noreply.github.com.example.test'),
  ]), [
    { commit: 'b1', where: ['committer'] },
    { commit: 'b2', where: ['author'] },
    { commit: 'b3', where: ['author', 'committer'] },
    { commit: 'b4', where: ['committer'] },
  ]);
});
