import assert from 'node:assert/strict';
import test from 'node:test';

import { openRoutes } from '../src/runner/call-routes.js';
import { setAsideHostCopy } from '../src/runner/leave-global-copy.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { enabled, replicaFixture } from '../test-support/replica-neo4j.js';

test('releasing the host copy retains the project, its assignment and memory at the next independent start',
  { skip: !enabled, timeout: 300_000 }, async t => {
    let role;
    const agentId = 'sample-keeper';
    const fixture = await replicaFixture(t, { seedHost: async ({ request, token, spaceId }) => {
      const space = { personal_space_id: spaceId };
      const created = await request('/v1/occupations', { ...space, name_en: 'Synthetic sample keeper',
        description_en: 'Maintain the sample.' }, { token });
      role = created.key;
      await request('/v1/personal-projects', { ...space, project_id: 'host-project',
        profile: { name: 'Host project', lifecycle: 'active', purpose: 'Test the shared roster.' } }, { token, method: 'PUT' });
      await request('/v1/project-agents', { ...space, personal_project_id: 'host-project', agent_id: agentId, occupation: { role },
        profile: { name: 'Sample Keeper', responsibility: 'Maintain the sample.', allowed_clients: ['codex'],
          work_kinds: ['implementation'], capabilities: ['coding'] } }, { token, method: 'PUT' });
    } });
    const { dataDir, spaceId, cypher } = fixture;
    assert.equal((await fixture.sync(true)).outcome, 'synced');
    await fixture.project('sample');
    const routes = openRoutes(dataDir);
    routes.setLocalProject('project:sample', null);
    routes.close();
    const scope = { personal_space_id: spaceId, personal_project_id: 'sample', agent_id: agentId };
    await fixture.client().createProjectAgentAssignment({ ...scope, idempotency_key: 'sample-assignment',
      responsibility: 'Keep the sample.', work_kinds: ['implementation'], capabilities: ['coding'], reason: 'Synthetic staffing.' });
    await fixture.client().writeProjectAgentMemory({ ...scope, expected_revision: 0, idempotency_key: 'sample-memory',
      source_application: 'codex', memory: { summary: 'Synthetic project memory' } });
    // The fixture supplies an external disposable database; the offline directory copy and its order
    // relative to release are exercised in runner-leave-own-data. Here the release and restarts are real.
    const result = await setAsideHostCopy(resolveSetupPaths({ dataDir }), {
      stop: fixture.stop, copy: async () => ({ folder: 'synthetic-offline-copy' }), restart: () => fixture.restart(true) });
    assert.equal(result.released, true);
    await fixture.restart(false);
    assert.equal((await fixture.client().health()).globalReplica, false);
    const updated = await fixture.client().updateProjectAgentOccupation(agentId, { personal_space_id: spaceId, role, tags: [] });
    assert.equal(updated.occupation.role, role, 'the independent Provider accepts a write requiring the retained custom occupation');
    const [held] = await cypher(`MATCH (:FuliSpace {id:$space})-[:CONTAINS_PROJECT]->(p {project_id:'sample'})
      MATCH (p)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(assignment)-[:ASSIGNED_AGENT]->(agent {agent_id:$agentId})
      RETURN assignment.status AS status, agent.fuli_replica_owner AS owner`, { space: spaceId, agentId });
    assert.deepEqual(held, { status: 'active', owner: null });
    const memory = await fixture.client().getProjectAgentMemory({ personalSpaceId: spaceId, personalProjectId: 'sample', agentId });
    assert.equal(memory.current.memory.summary, 'Synthetic project memory');
  });
