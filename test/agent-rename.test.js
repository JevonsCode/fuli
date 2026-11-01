import assert from 'node:assert/strict';
import test from 'node:test';

import { renameProjectAgent } from '../src/graphiti/project-agent-workflows.js';

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
