import assert from 'node:assert/strict';
import test from 'node:test';

import { listAgentNameChanges, renameProjectAgent } from '../src/graphiti/project-agent-workflows.js';

// rec#11 D-89: the shown name only, through the Provider's own rename. Synthetic Agents only.
test('a rename sends only the name, and null gives a built-in role its own name back', async () => {
  const calls = [];
  const record = (agentId, displayName) => ({ agent_id: agentId, personal_space_id: 'space-a', personal_project_id: null,
    memory_scope: 'reviewed_agent', profile: { name: 'Bole', display_name: displayName, responsibility: 'AR', status: 'active',
      capabilities: [], work_kinds: [], agent_type: 'hr' } });
  const application = { personal: { renameProjectAgent: async (agentId, body) => {
    calls.push([agentId, body]);
    return record(agentId, body.display_name ?? 'Bole');
  } } };
  const renamed = await renameProjectAgent(application, { personalSpaceId: 'space-a', agentId: 'employee.bole', displayName: '伯乐' });
  assert.equal(renamed.profile.displayName, '伯乐');
  assert.equal(renamed.profile.name, 'Bole');
  await renameProjectAgent(application, { personalSpaceId: 'space-a', agentId: 'employee.bole', displayName: null });
  assert.deepEqual(calls, [
    ['employee.bole', { personal_space_id: 'space-a', display_name: '伯乐' }],
    ['employee.bole', { personal_space_id: 'space-a', display_name: null }]
  ]);
});

test('a renamed record carries its 原名 and name history, and the renames list names who kept each name', async () => {
  const change = { name: 'Morgan Vale', until: '2026-11-23T00:00:00Z', reason: 'duplicate_name',
    kept_by_agent_id: 'morgan-a', gave_way: 'less_recent' };
  const application = { personal: {
    renameProjectAgent: async agentId => ({ agent_id: agentId, personal_space_id: 'space-a', former_name: 'Morgan Vale',
      name_history: [change], profile: { name: '开发', display_name: 'Lyra Lane', responsibility: 'Synthetic', status: 'active' } }),
    listAgentNameChanges: async space => [{ agent_id: 'morgan-b', display_name: 'Lyra Lane', status: 'active', change,
      kept_by_name: space === 'space-a' ? 'Morgan Vale' : null }]
  } };
  const renamed = await renameProjectAgent(application, { personalSpaceId: 'space-a', agentId: 'morgan-b', displayName: 'Lyra Lane' });
  assert.equal(renamed.formerName, 'Morgan Vale');
  assert.deepEqual(renamed.nameHistory, [{ name: 'Morgan Vale', until: '2026-11-23T00:00:00Z', reason: 'duplicate_name',
    keptByAgentId: 'morgan-a', gaveWay: 'less_recent' }]);
  assert.deepEqual(await listAgentNameChanges(application, { personalSpaceId: 'space-a' }), [{ agentId: 'morgan-b',
    displayName: 'Lyra Lane', status: 'active', keptByName: 'Morgan Vale', change: renamed.nameHistory[0] }]);
});
