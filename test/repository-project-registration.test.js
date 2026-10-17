import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { registerRepositoryProject } from '../src/graphiti/repository-project-registration.js';

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
