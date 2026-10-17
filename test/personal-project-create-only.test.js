import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

// HTTP Provider double and synthetic identifiers only.
const SPACE = 'test-space';
const config = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-provider-token', principalId: 'test-person', spaceId: SPACE } };

test('create-only reaches the Provider only when asked, so older Providers keep accepting upserts', async () => {
  const bodies = [];
  const fetchImpl = async (_url, options = {}) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ project_id: 'p', personal_space_id: SPACE, publication_key: 'k',
      profile: { name: 'P' }, created_at: '2026-10-17T00:00:00Z', updated_at: '2026-10-17T00:00:00Z' });
  };
  const app = new FederatedGraphApplication(config, { fetchImpl });
  const input = { personalSpaceId: SPACE, projectId: 'p', profile: { name: 'P' } };
  await app.upsertPersonalProject({ ...input, createOnly: true });
  await app.upsertPersonalProject(input);
  assert.equal(bodies[0].create_only, true);
  assert.equal(Object.hasOwn(bodies[1], 'create_only'), false);
});
