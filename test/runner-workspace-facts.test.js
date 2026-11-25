import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callerRepository, resolveCallerProjectPath, runWithCallerWorkspaces } from '../src/graphiti/caller-workspace.js';
import { describeWorkspace, parseWorkspaceFacts } from '../src/graphiti/workspace-facts.js';

// A checkout on the runner, at a path the host does not have.
function runnerCheckout(t, { folder = 'renamed-clone', remote = 'git@example.test:team/widgets.git' } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-facts-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, folder);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, '.git', 'config'),
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://person:secret-token@${remote.replace(/^git@([^:]+):/, '$1/')}\n`);
  writeFileSync(path.join(root, 'README.md'), '# Widgets\n\nWidgets ships the small parts of the order flow.\n');
  return { base, root };
}

const sourced = (projectId, uri) => ({ project_id: projectId, profile: { sources: [{ kind: 'repository', uri }] } });

test('a runner folder is matched on the host by its origin, whatever the folder is called', async (t) => {
  const { root } = runnerCheckout(t);
  const facts = parseWorkspaceFacts(JSON.parse(JSON.stringify(await describeWorkspace(path.join(root, 'src')))));
  const lookup = (value) => (value === facts.requestedPath ? facts : null);
  rmSync(root, { recursive: true, force: true }); // the host never reads the runner's disk

  const resolution = runWithCallerWorkspaces(lookup, () =>
    resolveCallerProjectPath(path.join(root, 'src'), [sourced('widgets', 'https://example.test/team/widgets')]));

  assert.deepEqual(resolution, { status: 'matched', basis: 'git_remote', personalProjectId: 'widgets' });
});

test('a runner folder carries no remote credential and offers its README draft for registration', async (t) => {
  const { root } = runnerCheckout(t, { folder: 'widgets' });
  const facts = await describeWorkspace(root);

  assert.doesNotMatch(JSON.stringify(facts), /secret-token|person:/);
  const repository = runWithCallerWorkspaces((value) => (value === root ? facts : null), () => callerRepository(root));
  assert.match(repository.draft.purpose, /small parts of the order flow/);
  assert.equal(repository.source.uri, 'https://example.test/team/widgets');
  const unregistered = runWithCallerWorkspaces((value) => (value === root ? facts : null),
    () => resolveCallerProjectPath(root, []));
  assert.equal(unregistered.status, 'unmatched');
  assert.equal(unregistered.repositoryProjectId, 'widgets');
});

test('a runner call naming a folder it did not describe is refused, and local calls read the disk', async (t) => {
  const { root } = runnerCheckout(t, { folder: 'widgets' });

  assert.throws(() => runWithCallerWorkspaces(() => null, () => resolveCallerProjectPath(root, [])),
    /projectPath was not described by this runner/);
  assert.equal(resolveCallerProjectPath(root, [{ project_id: 'widgets' }]).personalProjectId, 'widgets');
  assert.equal(callerRepository(root), null);
});

test('workspace facts from a runner are checked at the boundary', () => {
  assert.throws(() => parseWorkspaceFacts({ version: 1, platform: 'darwin', path: 'relative', requestedPath: '/a',
    entries: {}, texts: {} }), /runner format/);
  assert.throws(() => parseWorkspaceFacts({ version: 1, platform: 'darwin', path: '/a', requestedPath: '/a',
    entries: { '/a': 'socket' }, texts: {} }), /runner format/);
});

test('a recorded local project folder resolves a different ID only on the registering computer', async t => {
  const { root } = runnerCheckout(t);
  const own = id => ({ project_id: id, profile: { sources: [{ key: 'folder', kind: 'repository', uri: root }] } });
  assert.equal(resolveCallerProjectPath(root, [own('widgets')]).personalProjectId, 'widgets');
  assert.equal(resolveCallerProjectPath(path.join(root, 'src'), [own('widgets')]).basis, 'registered_folder');
  assert.equal(resolveCallerProjectPath(root, [own('widgets'), own('parts')]).status, 'ambiguous');
  const reference = own('widgets');
  reference.profile.sources[0].role = 'reference';
  assert.equal(resolveCallerProjectPath(root, [reference]).status, 'unmatched');
  const facts = await describeWorkspace(root);
  const remote = runWithCallerWorkspaces(() => facts, () => resolveCallerProjectPath(root, [own('widgets')]));
  assert.equal(remote.status, 'unmatched');
});
