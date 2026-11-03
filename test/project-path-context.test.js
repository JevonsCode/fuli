import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findRepositoryRoot,
  resolvePersonalProjectPath
} from '../src/graphiti/project-path-context.js';
import { errorToolResult } from '../src/mcp/tool-result.js';

const PROJECTS = Object.freeze([
  { project_id: 'fuli', profile: { sources: [{ kind: 'repository', uri: 'https://example.test/team/fuli' }] } },
  { project_id: 'projectb', profile: { sources: [{ kind: 'repository', uri: 'https://example.test/team/projectb' }] } }
]);

test('a matching directory name without a remote cannot establish ownership', () => {
  const existing = new Set(['/work/fuli/src', '/work/fuli/.git']);
  const options = { fileExists: candidate => existing.has(candidate),
    isDirectory: () => true, readText: () => '', pathApi: path.posix };
  assert.deepEqual(resolvePersonalProjectPath('/work/fuli/src', PROJECTS, options), {
    status: 'unmatched', basis: null, personalProjectId: null, reason: 'repository_remote_unavailable'
  });
  assert.equal(findRepositoryRoot('/work/fuli/src', options), '/work/fuli');
});

// Synthetic paths must not reach the host filesystem: wherever /workspace or
// /outside exists (such as T:\workspace on Windows), realpath would rewrite it.
test('a workspace root requires the actual repository path even with one named child', () => {
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

  assert.equal(resolution.personalProjectId, null);
  assert.equal(resolution.reason, 'workspace_requires_repository_path');
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

test('an unregistered repository never offers a directory-derived registration ID', () => {
  const existing = new Set(['/work/new-app/src', '/work/new-app/.git', '/work/tree', '/work/tree/.git']);
  const options = {
    fileExists: (candidate) => existing.has(candidate),
    isDirectory: () => true,
    realPath: (candidate) => candidate,
    readText: (file) => file === '/work/tree/.git' ? 'gitdir: /repos/origin-app/.git/worktrees/tree\n' : '',
    pathApi: path.posix
  };
  assert.deepEqual(resolvePersonalProjectPath('/work/new-app/src', PROJECTS, options), {
    status: 'unmatched', basis: null, personalProjectId: null, reason: 'repository_remote_unavailable'
  });
  assert.equal(resolvePersonalProjectPath('/work/tree', PROJECTS, options).repositoryProjectId, undefined);
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
    readText: file => file.endsWith('config') ? '[remote \"origin\"]\nurl = https://example.test/team/fuli' : '',
    pathApi: path.win32,
    ...extra
  };
}

test('a WSL drive path resolves on Windows exactly like the native drive path', () => {
  const host = windowsHost(new Set(['T:\\work\\fuli\\src', 'T:\\work\\fuli\\.git']));
  const native = resolvePersonalProjectPath('T:\\work\\fuli\\src', PROJECTS, host);
  assert.deepEqual(native, { status: 'matched', basis: 'git_remote', personalProjectId: 'fuli' });
  for (const wslPath of ['/mnt/t/work/fuli/src', '/mnt/T/work/fuli/src', '/mnt/t/work/fuli/src/',
    '/mnt/t/work//fuli/src//', '///mnt/t/work/fuli/src', '/mnt/t/work/./tmp/../fuli/src']) {
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
  assert.equal(resolvePersonalProjectPath('/mnt/t/work/../outside', PROJECTS, host).status, 'unmatched');
});

// The POSIX path is normalized before its drive is read: .. that crosses into
// another mount names that drive, and .. that leaves the mounts is no drive.
test('dot segments in a WSL path keep their POSIX meaning across and out of mounts', () => {
  const projects = [{ project_id: 'alpha' }];
  // A same-named repository at the location a naive mapping would reach.
  const wrong = new Set(['T:\\c\\work\\alpha', 'T:\\c\\work\\alpha\\.git', 'T:\\home\\me\\alpha',
    'T:\\home\\me\\alpha\\.git']);
  const host = windowsHost(wrong);
  assert.throws(() => resolvePersonalProjectPath('/mnt/t/../c/work/alpha', projects, host),
    /existing absolute directory/);
  assert.equal(findRepositoryRoot('/mnt/t/../c/work/alpha', host), null);
  const crossed = windowsHost(new Set([...wrong, 'C:\\work\\alpha', 'C:\\work\\alpha\\.git']));
  assert.deepEqual(resolvePersonalProjectPath('/mnt/t/../c/work/alpha', projects, crossed),
    resolvePersonalProjectPath('C:\\work\\alpha', projects, crossed));
  assert.equal(findRepositoryRoot('/mnt/t/../c/work/alpha', crossed), 'C:\\work\\alpha');
  for (const left of ['/mnt/t/../../home/me/alpha', '/mnt/t/..', '/mnt/t/../../mnt']) {
    assert.throws(() => resolvePersonalProjectPath(left, projects, crossed), { code: 'project_path_unsupported' });
    assert.throws(() => findRepositoryRoot(left, crossed), { code: 'project_path_unsupported' });
  }
});

test('a POSIX path a Windows FULI cannot open is a typed error that names the fix', () => {
  const opened = [];
  const host = windowsHost(new Set(), { fileExists: (candidate) => { opened.push(candidate); return false; } });
  for (const unsupported of ['/home/me/fuli', '/tmp', '/', '/mnt/wsl/fuli', '/mnt', '///home/me',
    '/mnt/t/a\\b', '/mnt/t/a:b',
    '\\\\wsl$\\Ubuntu\\home\\me', '//wsl$/Ubuntu/home/me', '\\/wsl$/Ubuntu', '\\\\\\wsl$\\Ubuntu',
    '\\\\wsl.localhost\\Ubuntu\\home\\me', '\\\\WSL.LOCALHOST\\Ubuntu', '\\\\Wsl$',
    '\\\\?\\UNC\\wsl$\\Ubuntu\\home\\alpha', '\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\alpha',
    '//?/unc/WSL$/Ubuntu', '\\\\.\\UNC\\wsl$\\Ubuntu', '\\\\.\\unc\\wsl.localhost\\Ubuntu']) {
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
  // Other UNC shares, extended forms included, are ordinary Windows paths and get
  // the ordinary checks. Exactly two leading slashes is implementation-defined in
  // POSIX and UNC under Windows rules, so //mnt/t is a share, never the T: drive.
  const shares = windowsHost(new Set(['T:\\work\\fuli', 'T:\\work\\fuli\\.git', '\\\\server\\share\\fuli',
    '\\\\server\\share\\fuli\\.git']));
  assert.equal(resolvePersonalProjectPath('\\\\server\\share\\fuli', PROJECTS, shares).personalProjectId, 'fuli');
  for (const share of ['//mnt/t/work/fuli', '\\\\?\\UNC\\server\\share\\missing', '\\\\.\\UNC\\server\\missing']) {
    assert.throws(() => resolvePersonalProjectPath(share, PROJECTS, shares), /existing absolute directory/, share);
  }
});

test('POSIX hosts resolve /mnt and /home paths unchanged', () => {
  const existing = new Set(['/mnt/t/work/fuli', '/mnt/t/work/fuli/.git', '/home/me/projectb',
    '/home/me/projectb/.git']);
  const host = {
    fileExists: (candidate) => existing.has(candidate),
    isDirectory: () => true,
    realPath: (candidate) => candidate,
    readText: file => file.endsWith('config') ? `[remote \"origin\"]\nurl = https://example.test/team/${file.includes('projectb') ? 'projectb' : 'fuli'}` : '',
    pathApi: path.posix
  };
  assert.equal(resolvePersonalProjectPath('/mnt/t/work/fuli', PROJECTS, host).personalProjectId, 'fuli');
  assert.equal(resolvePersonalProjectPath('/home/me/projectb', PROJECTS, host).personalProjectId, 'projectb');
  assert.equal(findRepositoryRoot('/mnt/t/work/fuli', host), '/mnt/t/work/fuli');
});

// A separate clone under its own folder name: only the origin remote in its
// synthetic .git/config names the project. Temporary directories only.
function cloneFixture(t, folder, config, extraFiles = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'fuli-remote-match-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clone = path.join(root, folder);
  mkdirSync(path.join(clone, '.git'), { recursive: true });
  mkdirSync(path.join(clone, 'src'));
  writeFileSync(path.join(clone, '.git', 'config'), config);
  for (const [relative, text] of Object.entries(extraFiles)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  }
  return { root, clone };
}

const repositoryProject = (projectId, uri, extra = {}) => ({
  project_id: projectId,
  profile: { name: projectId, sources: [{ key: 'repo', kind: 'repository', title: 'GitHub', uri }] },
  ...extra
});

const originConfig = (url) => '[core]\n\trepositoryformatversion = 0\n'
  + '[remote "upstream"]\n\turl = https://github.com/other/fuli.git\n'
  + `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

test('a clone under another folder name resolves by its origin remote', (t) => {
  const { clone } = cloneFixture(t, 'fuli-ds-capture-flake', originConfig('git@github.com:JevonsCode/fuli.git'));
  const projects = [repositoryProject('fuli', 'https://GitHub.com/JevonsCode/fuli'), { project_id: 'projectb' }];
  assert.deepEqual(resolvePersonalProjectPath(path.join(clone, 'src'), projects), {
    status: 'matched', basis: 'git_remote', personalProjectId: 'fuli'
  });
  for (const uri of ['ssh://git@github.com:22/JevonsCode/fuli.git', 'https://user@github.com/JevonsCode/fuli.git/',
    'github.com:JevonsCode/fuli', 'git://github.com/JevonsCode/fuli']) {
    assert.equal(resolvePersonalProjectPath(clone, [repositoryProject('fuli', uri)]).basis, 'git_remote', uri);
  }
});

test('the remote wins over the folder name and never matches partially', (t) => {
  const { clone } = cloneFixture(t, 'projectb', originConfig('https://github.com/JevonsCode/fuli.git'));
  assert.equal(resolvePersonalProjectPath(clone, [repositoryProject('fuli', 'https://github.com/JevonsCode/fuli'),
    { project_id: 'projectb' }]).personalProjectId, 'fuli');
  for (const uri of ['https://github.com/JevonsCode/fuli-web', 'https://github.com/JevonsCode', 'https://github.com/jevonscode/fuli',
    'https://github.com/JevonsCode/fuli/tree/main', 'https://gitlab.com/JevonsCode/fuli']) {
    assert.deepEqual(resolvePersonalProjectPath(clone, [repositoryProject('fuli', uri)]), {
      status: 'unmatched', basis: null, personalProjectId: null, reason: 'repository_remote_unregistered'
    }, uri);
  }
});

test('a remote shared by two projects is ambiguous, and temporary or non-repository sources never match', (t) => {
  const { clone } = cloneFixture(t, 'task-clone', originConfig('https://github.com/JevonsCode/fuli.git'));
  const uri = 'git@github.com:JevonsCode/fuli.git';
  assert.deepEqual(resolvePersonalProjectPath(clone, [repositoryProject('fuli', uri), repositoryProject('fuli-old', uri)]), {
    status: 'ambiguous', basis: null, personalProjectId: null, reason: 'repository_remote_ambiguous', candidateCount: 2
  });
  assert.equal(resolvePersonalProjectPath(clone, [repositoryProject('fuli', uri),
    repositoryProject('scratch', uri, { scope_type: 'temporary' })]).personalProjectId, 'fuli');
  const runbook = repositoryProject('fuli', uri);
  runbook.profile.sources[0].kind = 'runbook';
  assert.equal(resolvePersonalProjectPath(clone, [runbook]).status, 'unmatched');
});

test('a worktree reads the origin remote from its common directory', (t) => {
  const { root, clone } = cloneFixture(t, 'repo-copy', originConfig('https://github.com/JevonsCode/fuli'), {
    'repo-copy/.git/worktrees/task/commondir': '../..\n'
  });
  const worktree = path.join(root, 'task-worktree');
  mkdirSync(worktree);
  writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(clone, '.git', 'worktrees', 'task')}\n`);
  assert.deepEqual(resolvePersonalProjectPath(worktree, [repositoryProject('fuli', 'git@github.com:JevonsCode/fuli.git')]), {
    status: 'matched', basis: 'git_remote', personalProjectId: 'fuli'
  });
  assert.equal(resolvePersonalProjectPath(worktree, [{ project_id: 'repo-copy' }]).reason, 'repository_remote_unregistered');
  assert.equal(resolvePersonalProjectPath(worktree, [repositoryProject('fuli', 'https://github.com/JevonsCode/other')])
    .repositoryProjectId, undefined);
});

test('a clone without an origin remote or with a local origin stays unmatched', (t) => {
  const projects = [repositoryProject('fuli', 'https://github.com/JevonsCode/fuli')];
  for (const config of ['[core]\n\tbare = false\n', '[remote "upstream"]\n\turl = https://github.com/JevonsCode/fuli\n',
    originConfig('/srv/git/fuli.git'), originConfig('C:/git/fuli.git'), originConfig('file:///srv/github.com/JevonsCode/fuli')]) {
    const { clone } = cloneFixture(t, 'task-clone', config);
    assert.equal(resolvePersonalProjectPath(clone, projects).status, 'unmatched', config);
  }
});
