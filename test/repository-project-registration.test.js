import assert from 'node:assert/strict';
import test from 'node:test';

import { registerRepositoryProject } from '../src/graphiti/repository-project-registration.js';

const app = (upsert) => ({ config: { personal: { spaceId: 'space' } }, upsertPersonalProject: upsert });

test('a task in an unregistered repository registers it under its exact ID', async () => {
  const writes = [];
  const result = await registerRepositoryProject(app(async (input) => { writes.push(input); }),
    { status: 'unmatched', personalProjectId: null, repositoryProjectId: 'new-app' });
  assert.deepEqual(result, { status: 'matched', basis: 'registered_repository', personalProjectId: 'new-app' });
  assert.deepEqual(writes, [{ personalSpaceId: 'space', projectId: 'new-app',
    profile: { name: 'new-app', lifecycle: 'active' } }]);
});

test('a failed registration leaves the task unresolved instead of guessing', async () => {
  const unresolved = { status: 'unmatched', personalProjectId: null, repositoryProjectId: 'new-app' };
  assert.equal(await registerRepositoryProject(app(async () => { throw new Error('offline'); }), unresolved), unresolved);
});
