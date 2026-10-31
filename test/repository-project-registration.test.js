import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { registerRepositoryProject } from '../src/graphiti/repository-project-registration.js';
import { resolvePersonalProjectPath } from '../src/graphiti/project-path-context.js';

const app = (upsert) => ({ config: { personal: { spaceId: 'space' } }, upsertPersonalProject: upsert });

test('a task in an unregistered repository registers it under its exact ID', async t => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'fuli-registration-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  await mkdir(path.join(projectPath, '.git'));
  await writeFile(path.join(projectPath, 'README.md'), '# Sample\n\nA sample app.');
  const writes = [];
  const result = await registerRepositoryProject(app(async (input) => { writes.push(input); }),
    { status: 'unmatched', personalProjectId: null, repositoryProjectId: 'new-app' }, { projectPath });
  assert.deepEqual(result, { status: 'matched', basis: 'registered_repository', personalProjectId: 'new-app' });
  assert.deepEqual(writes, [{ personalSpaceId: 'space', projectId: 'new-app',
    profile: { name: 'new-app', lifecycle: 'active', purpose: 'A sample app.',
      brief_draft: { source: 'readme', label: 'AI draft', editable: true } } }]);
});

test('a failed registration leaves the task unresolved instead of guessing', async () => {
  const unresolved = { status: 'unmatched', personalProjectId: null, repositoryProjectId: 'new-app' };
  assert.equal(await registerRepositoryProject(app(async () => { throw new Error('offline'); }), unresolved), unresolved);
});

test('registered origin sources are safe and resolve a second clone by remote', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'fuli-register-origin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    ['git@GitHub.com:Example/Widget.git', 'https://github.com/Example/Widget', 'Example/Widget'],
    ['ssh://git@github.com:22/Example/Widget.git/', 'https://github.com/Example/Widget', 'Example/Widget'],
    ['https://alice:secret@github.com/Example/Widget.git', 'https://github.com/Example/Widget', 'Example/Widget'],
    ['http://alice:secret@github.com/Example/Widget.git', 'https://github.com/Example/Widget', 'Example/Widget'],
    ['git://github.com/Example/Widget.git', 'git://github.com/Example/Widget.git', 'Example/Widget'],
    ['git://alice:secret@github.com/Example/Widget.git', 'git://github.com/Example/Widget.git', 'Example/Widget'],
    ['/srv/git/Widget.git', '/srv/git/Widget.git', 'git/Widget']
  ];
  for (const [index, [remote, uri, title]] of cases.entries()) {
    const first = path.join(root, `first-${index}`);
    const second = path.join(root, `second-${index}`);
    for (const repo of [first, second]) {
      await mkdir(path.join(repo, '.git'), { recursive: true });
      await mkdir(path.join(repo, 'src'));
      await writeFile(path.join(repo, '.git', 'config'), `[remote "origin"]\n  url = ${remote}\n`);
    }
    await writeFile(path.join(first, 'README.md'), 'A sample app.');
    const writes = [];
    const resolution = resolvePersonalProjectPath(path.join(first, 'src'), []);
    const registered = await registerRepositoryProject(app(async input => writes.push(input)), resolution,
      { projectPath: path.join(first, 'src') });
    assert.equal(registered.basis, 'registered_repository');
    assert.deepEqual(writes[0].profile.sources, [{ key: 'origin-remote', kind: 'repository', title, uri, sensitivity: 'normal' }]);
    assert.doesNotMatch(JSON.stringify(writes), /alice|secret/);
    if (!remote.startsWith('/')) {
      assert.deepEqual(resolvePersonalProjectPath(path.join(second, 'src'), [{ project_id: registered.personalProjectId, profile: writes[0].profile }]),
        { status: 'matched', basis: 'git_remote', personalProjectId: registered.personalProjectId });
    }
  }
});

test('registration from a worktree reads its common origin config', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'fuli-register-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'task');
  const gitdir = path.join(main, '.git', 'worktrees', 'task');
  await mkdir(gitdir, { recursive: true });
  await mkdir(worktree);
  await writeFile(path.join(main, '.git', 'config'), '[remote "origin"]\n  url = git@github.com:Example/Widget.git\n');
  await writeFile(path.join(gitdir, 'commondir'), '../..\n');
  await writeFile(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`);
  await writeFile(path.join(worktree, 'README.md'), 'A sample app.');
  const writes = [];
  const resolution = resolvePersonalProjectPath(worktree, []);
  await registerRepositoryProject(app(async input => writes.push(input)), resolution, { projectPath: worktree });
  assert.deepEqual(writes[0].profile.sources, [{ key: 'origin-remote', kind: 'repository', title: 'Example/Widget',
    uri: 'https://github.com/Example/Widget', sensitivity: 'normal' }]);
});
