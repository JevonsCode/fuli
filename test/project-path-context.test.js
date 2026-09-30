import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  findRepositoryRoot,
  resolvePersonalProjectPath
} from '../src/graphiti/project-path-context.js';

const PROJECTS = Object.freeze([
  { project_id: 'fuli' },
  { project_id: 'projectb' }
]);

test('project path resolves an exact repository id without fuzzy matching', () => {
  const existing = new Set([
    '/work/fuli/src',
    '/work/fuli/.git'
  ]);
  const resolution = resolvePersonalProjectPath('/work/fuli/src', PROJECTS, {
    fileExists: (candidate) => existing.has(candidate),
    isDirectory: (candidate) => candidate === '/work/fuli/src',
    pathApi: path.posix
  });

  assert.deepEqual(resolution, {
    status: 'matched',
    basis: 'repository_root',
    personalProjectId: 'fuli'
  });
  assert.equal(
    findRepositoryRoot('/work/fuli/src', {
      fileExists: (candidate) => existing.has(candidate),
      pathApi: path.posix
    }),
    '/work/fuli'
  );
});

test('project path resolves the original repository behind a Codex worktree', () => {
  const existing = new Set([
    '/worktrees/task-1',
    '/worktrees/task-1/.git'
  ]);
  const resolution = resolvePersonalProjectPath('/worktrees/task-1', PROJECTS, {
    fileExists: (candidate) => existing.has(candidate),
    isDirectory: (candidate) => candidate === '/worktrees/task-1',
    readText: () => 'gitdir: /projects/fuli/.git/worktrees/task-1\n',
    pathApi: path.posix
  });

  assert.equal(resolution.personalProjectId, 'fuli');
  assert.equal(resolution.basis, 'git_worktree_origin');
});

test('repository directory case can differ from one unambiguous registered project ID', () => {
  const existing = new Set(['/work/ProjectA', '/work/ProjectA/.git']);
  const resolution = resolvePersonalProjectPath('/work/ProjectA', [{ project_id: 'projecta' }], {
    fileExists: value => existing.has(value), isDirectory: () => true,
    readText: () => '', pathApi: path.posix
  });
  assert.equal(resolution.personalProjectId, 'projecta');
  assert.equal(resolution.basis, 'repository_root_case_insensitive');
});

test('worktree origin wins over a folder named after another project and supports case differences', () => {
  const existing = new Set(['/worktrees/fuli', '/worktrees/fuli/.git']);
  const options = {
    fileExists: value => existing.has(value), isDirectory: () => true,
    readText: () => 'gitdir: /projects/ProjectA/.git/worktrees/task\n', pathApi: path.posix
  };
  const resolution = resolvePersonalProjectPath('/worktrees/fuli', [
    { project_id: 'fuli' }, { project_id: 'projecta' }
  ], options);
  assert.equal(resolution.personalProjectId, 'projecta');
  assert.equal(resolution.basis, 'git_worktree_origin_case_insensitive');
  assert.equal(resolvePersonalProjectPath('/worktrees/fuli', [{ project_id: 'fuli' }], options).status, 'unmatched');
});

test('case-insensitive resolution never guesses between colliding IDs or similar names', () => {
  const options = {
    fileExists: () => true, isDirectory: () => true, readText: () => '', pathApi: path.posix
  };
  assert.equal(resolvePersonalProjectPath('/work/PROJECTA', [
    { project_id: 'projecta' }, { project_id: 'ProjectA' }
  ], options).status, 'ambiguous');
  assert.equal(resolvePersonalProjectPath('/work/ProjectA', [{ project_id: 'projecta' }], {
    ...options, readText: () => 'gitdir: /projects/project-a/.git/worktrees/task'
  }).status, 'unmatched');
});

test('a workspace root resolves only one exact registered child project', () => {
  const existing = new Set([
    '/workspace',
    '/workspace/fuli/.git'
  ]);
  const resolution = resolvePersonalProjectPath('/workspace', PROJECTS, {
    fileExists: (candidate) => existing.has(candidate),
    isDirectory: (candidate) => candidate === '/workspace',
    pathApi: path.posix
  });

  assert.equal(resolution.personalProjectId, 'fuli');
  assert.equal(resolution.basis, 'workspace_child');
});

test('ambiguous, unmatched, and invalid project paths never guess a project', () => {
  const existing = new Set([
    '/workspace',
    '/workspace/fuli/.git',
    '/workspace/projectb/package.json',
    '/outside',
    '/outside/file.txt'
  ]);
  const fileExists = (candidate) => existing.has(candidate);

  assert.deepEqual(
    resolvePersonalProjectPath('/workspace', PROJECTS, {
      fileExists,
      isDirectory: (candidate) => candidate === '/workspace',
      pathApi: path.posix
    }),
    {
      status: 'ambiguous',
      basis: null,
      personalProjectId: null,
      candidateCount: 2
    }
  );
  assert.equal(
    resolvePersonalProjectPath('/outside', PROJECTS, {
      fileExists,
      isDirectory: (candidate) => candidate === '/outside',
      pathApi: path.posix
    }).status,
    'unmatched'
  );
  assert.throws(
    () => resolvePersonalProjectPath('relative/project', PROJECTS, {
      fileExists,
      pathApi: path.posix
    }),
    /existing absolute directory/
  );
  assert.throws(
    () => resolvePersonalProjectPath('/outside/file.txt', PROJECTS, {
      fileExists,
      isDirectory: () => false,
      pathApi: path.posix
    }),
    /existing absolute directory/
  );
});
