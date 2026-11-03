import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePersonalProjectPath } from '../src/graphiti/project-path-context.js';

test('real Git clones and a worktree resolve to one registered repository', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'fuli-checkouts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  const projects = [{ project_id: 'sample', profile: {
    sources: [{ kind: 'repository', uri: 'https://example.test/team/sample' }]
  } }];
  const original = path.join(root, 'original');
  mkdirSync(original);
  git(original, 'init');
  git(original, 'remote', 'add', 'origin', 'https://example.test/team/sample.git');
  git(original, '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'fixture');
  const clone = path.join(root, 'different-name');
  git(root, 'clone', original, clone);
  git(clone, 'remote', 'set-url', 'origin', 'git@example.test:team/sample.git');
  const worktree = path.join(root, 'yet-another-name');
  git(original, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b', 'fixture', worktree);
  for (const checkout of [original, clone, worktree]) {
    assert.deepEqual(resolvePersonalProjectPath(checkout, projects), {
      status: 'matched', basis: 'git_remote', personalProjectId: 'sample'
    });
  }
});
