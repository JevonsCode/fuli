import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workingBranch } from '../src/conversations/working-branch.js';

// Synthetic repositories only: a .git folder, a worktree's gitdir file, a detached HEAD.
test('the branch comes from the nearest .git up the folder, a worktree file included', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-branch-'));
  try {
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    await writeFile(join(root, 'repo', '.git', 'HEAD'), 'ref: refs/heads/JVS/synthetic-branch\n');
    await mkdir(join(root, 'repo', 'src', 'deep'), { recursive: true });
    assert.equal(await workingBranch(join(root, 'repo', 'src', 'deep')), 'JVS/synthetic-branch');

    await mkdir(join(root, 'gitdirs', 'wt'), { recursive: true });
    await writeFile(join(root, 'gitdirs', 'wt', 'HEAD'), 'ref: refs/heads/synthetic-worktree\n');
    await mkdir(join(root, 'wt'), { recursive: true });
    await writeFile(join(root, 'wt', '.git'), `gitdir: ${join(root, 'gitdirs', 'wt')}\n`);
    assert.equal(await workingBranch(join(root, 'wt')), 'synthetic-worktree');

    await writeFile(join(root, 'gitdirs', 'wt', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    assert.equal(await workingBranch(join(root, 'wt')), null, 'a detached HEAD is unknown, not a guess');

    // A .git file pointing nowhere inside the repository is unknown, never the parent's branch.
    await mkdir(join(root, 'repo', 'nested'), { recursive: true });
    await writeFile(join(root, 'repo', 'nested', '.git'), 'not a pointer\n');
    assert.equal(await workingBranch(join(root, 'repo', 'nested')), null);
    // Past its time limit the branch is unknown rather than late.
    assert.equal(await workingBranch(join(root, 'repo'), { timeLimitMs: 0 }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a folder outside Git, a missing folder or no folder has no branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-nobranch-'));
  try {
    assert.equal(await workingBranch(join(root, 'missing')), null);
    assert.equal(await workingBranch(''), null);
    assert.equal(await workingBranch(null), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
