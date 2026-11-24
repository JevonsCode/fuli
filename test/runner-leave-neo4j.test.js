import assert from 'node:assert/strict';
import test from 'node:test';

import { openRoutes } from '../src/runner/call-routes.js';
import { setAsideHostCopy } from '../src/runner/leave-global-copy.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { enabled, OWNER, replicaFixture } from '../test-support/replica-neo4j.js';

test('releasing the host copy retains the project, its assignment and memory at the next independent start',
  { skip: !enabled, timeout: 300_000 }, async t => {
    const fixture = await replicaFixture(t);
    const { dataDir, spaceId, cypher } = fixture;
    assert.equal((await fixture.sync(true)).outcome, 'synced');
    await fixture.project('sample');
    const routes = openRoutes(dataDir);
    routes.setLocalProject('project:sample', null);
    routes.close();
    await cypher(`MATCH (space:FuliSpace {id: $space})-[:CONTAINS_PROJECT]->(project {project_id: 'sample'})
      MATCH (agent:FuliProjectAgent {fuli_replica_owner: $owner}) WITH space, project, agent LIMIT 1
      CREATE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(:FuliProjectAgentAssignment {id:'sample-assignment',
        status:'active'})-[:ASSIGNED_AGENT]->(agent)
      CREATE (agent)-[:HAS_WORKING_MEMORY]->(:FuliProjectAgentMemory {id:'sample-memory', personal_space_id:$space,
        personal_project_id:'sample', content:'Synthetic project memory'})`, { space: spaceId, owner: OWNER });
    // The fixture supplies an external disposable database; the offline directory copy and its order
    // relative to release are exercised in runner-leave-own-data. Here the release and restarts are real.
    const result = await setAsideHostCopy(resolveSetupPaths({ dataDir }), {
      stop: fixture.stop, copy: async () => ({ folder: 'synthetic-offline-copy' }), restart: () => fixture.restart(true) });
    assert.equal(result.released, true);
    await fixture.restart(false);
    assert.equal((await fixture.client().health()).globalReplica, false);
    const [held] = await cypher(`MATCH (:FuliSpace {id:$space})-[:CONTAINS_PROJECT]->(p {project_id:'sample'})
      MATCH (p)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(assignment {id:'sample-assignment'})-[:ASSIGNED_AGENT]->(agent)
      MATCH (agent)-[:HAS_WORKING_MEMORY]->(memory {id:'sample-memory'})
      RETURN assignment.status AS status, memory.content AS memory, agent.fuli_replica_owner AS owner`, { space: spaceId });
    assert.deepEqual(held, { status: 'active', memory: 'Synthetic project memory', owner: null });
  });
