import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  findRepositoryRoot,
  resolvePersonalProjectPath
} from '../src/graphiti/project-path-context.js';
import { errorToolResult } from '../src/mcp/tool-result.js';

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

// Synthetic paths must not reach the host filesystem: wherever /workspace or
// /outside exists (such as T:\workspace on Windows), realpath would rewrite it.
test('a workspace root resolves only one exact registered child project', () => {
  const existing = new Set([
    '/workspace',
    '/workspace/fuli/.git'
  ]);
  const resolution = resolvePersonalProjectPath('/workspace', PROJECTS, {
    fileExists: (candidate) => existing.has(candidate),
    isDirectory: (candidate) => candidate === '/workspace',
    realPath: (candidate) => candidate,
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
      realPath: (candidate) => candidate,
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
      realPath: (candidate) => candidate,
      pathApi: path.posix
    }).status,
    'unmatched'
  );
  assert.throws(
    () => resolvePersonalProjectPath('relative/project', PROJECTS, {
      fileExists,
      realPath: (candidate) => candidate,
      pathApi: path.posix
    }),
    /existing absolute directory/
  );
  assert.throws(
    () => resolvePersonalProjectPath('/outside/file.txt', PROJECTS, {
      fileExists,
      isDirectory: () => false,
      realPath: (candidate) => candidate,
      pathApi: path.posix
    }),
    /existing absolute directory/
  );
});

test('an unregistered repository is reported as the exact ID to register', () => {
  const existing = new Set(['/work/new-app/src', '/work/new-app/.git', '/work/tree', '/work/tree/.git']);
  const options = {
    fileExists: (candidate) => existing.has(candidate),
    isDirectory: () => true,
    realPath: (candidate) => candidate,
    readText: (file) => file === '/work/tree/.git' ? 'gitdir: /repos/origin-app/.git/worktrees/tree\n' : '',
    pathApi: path.posix
  };
  assert.deepEqual(resolvePersonalProjectPath('/work/new-app/src', PROJECTS, options), {
    status: 'unmatched', basis: null, personalProjectId: null, repositoryProjectId: 'new-app'
  });
  assert.equal(resolvePersonalProjectPath('/work/tree', PROJECTS, options).repositoryProjectId, 'origin-app');
  assert.equal(resolvePersonalProjectPath('/outside', PROJECTS, {
    ...options, fileExists: (candidate) => candidate === '/outside'
  }).repositoryProjectId, undefined);
});

// rec#48: an Agent in WSL reports /mnt/<drive>/... to a Windows FULI. The
// platform is injected through its path rules; synthetic paths never reach disk.
function windowsHost(existing, extra = {}) {
  return {
    fileExists: (candidate) => existing.has(candidate),
    isDirectory: (candidate) => existing.has(candidate) && !candidate.endsWith('.txt'),
    realPath: (candidate) => candidate,
    readText: () => '',
    pathApi: path.win32,
    ...extra
  };
}

test('a WSL drive path resolves on Windows exactly like the native drive path', () => {
  const host = windowsHost(new Set(['T:\\work\\fuli\\src', 'T:\\work\\fuli\\.git']));
  const native = resolvePersonalProjectPath('T:\\work\\fuli\\src', PROJECTS, host);
  assert.deepEqual(native, { status: 'matched', basis: 'repository_root', personalProjectId: 'fuli' });
  for (const wslPath of ['/mnt/t/work/fuli/src', '/mnt/T/work/fuli/src', '/mnt/t/work/fuli/src/',
    '/mnt/t/work//fuli/src//']) {
    assert.deepEqual(resolvePersonalProjectPath(wslPath, PROJECTS, host), native, wslPath);
  }
  assert.equal(findRepositoryRoot('/mnt/t/work/fuli/src', host), 'T:\\work\\fuli');
  assert.equal(findRepositoryRoot('/mnt/t/', host), null);
});

test('a translated WSL path passes the same existence and project checks as a native path', () => {
  const host = windowsHost(new Set(['T:\\outside', 'T:\\outside\\file.txt', 'C:\\Windows']));
  assert.deepEqual(resolvePersonalProjectPath('/mnt/t/outside', PROJECTS, host),
    resolvePersonalProjectPath('T:\\outside', PROJECTS, host));
  assert.equal(resolvePersonalProjectPath('/mnt/t/outside', PROJECTS, host).status, 'unmatched');
  for (const wslPath of ['/mnt/t/missing', '/mnt/t/outside/file.txt']) {
    assert.throws(() => resolvePersonalProjectPath(wslPath, PROJECTS, host), /existing absolute directory/);
  }
  // Dot segments stay on the translated drive, as they do in the native path.
  assert.equal(resolvePersonalProjectPath('/mnt/t/../../outside', PROJECTS, host).status, 'unmatched');
  assert.throws(() => resolvePersonalProjectPath('/mnt/t/../../Windows', PROJECTS, host),
    /existing absolute directory/);
});

test('a POSIX path a Windows FULI cannot open is a typed error that names the fix', () => {
  const opened = [];
  const host = windowsHost(new Set(), { fileExists: (candidate) => { opened.push(candidate); return false; } });
  for (const unsupported of ['/home/me/fuli', '/tmp', '/', '/mnt/wsl/fuli', '/mnt', '\\\\wsl$\\Ubuntu\\home\\me',
    '//wsl$/Ubuntu/home/me', '\\\\wsl.localhost\\Ubuntu\\home\\me', '\\\\WSL.LOCALHOST\\Ubuntu']) {
    let error;
    assert.throws(() => resolvePersonalProjectPath(unsupported, PROJECTS, host), (thrown) => {
      error = thrown;
      return true;
    });
    const reported = errorToolResult(error).structuredContent.error;
    assert.equal(reported.code, 'project_path_unsupported', unsupported);
    assert.match(reported.message, /Windows path of the current working directory/);
    assert.doesNotMatch(reported.message, /Ubuntu|\/home|\/tmp|mnt\/wsl/);
    assert.throws(() => findRepositoryRoot(unsupported, host), { code: 'project_path_unsupported' });
  }
  assert.deepEqual(opened, []);
  // Other UNC shares are ordinary Windows paths and get the ordinary checks.
  assert.throws(() => resolvePersonalProjectPath('\\\\server\\share\\fuli', PROJECTS, host),
    /existing absolute directory/);
});

test('POSIX hosts resolve /mnt and /home paths unchanged', () => {
  const existing = new Set(['/mnt/t/work/fuli', '/mnt/t/work/fuli/.git', '/home/me/projectb',
    '/home/me/projectb/.git']);
  const host = {
    fileExists: (candidate) => existing.has(candidate),
    isDirectory: () => true,
    realPath: (candidate) => candidate,
    readText: () => '',
    pathApi: path.posix
  };
  assert.equal(resolvePersonalProjectPath('/mnt/t/work/fuli', PROJECTS, host).personalProjectId, 'fuli');
  assert.equal(resolvePersonalProjectPath('/home/me/projectb', PROJECTS, host).personalProjectId, 'projectb');
  assert.equal(findRepositoryRoot('/mnt/t/work/fuli', host), '/mnt/t/work/fuli');
});
