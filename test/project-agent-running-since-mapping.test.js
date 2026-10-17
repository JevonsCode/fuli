import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectAgentRecord,
  projectAgentTaskParticipantRecord
} from '../src/graphiti/project-agent-mapping.js';

const profile = { name: 'Synthetic engineer', responsibility: 'Maintain the sample.' };

test('roster carries the stamped run start and keeps it absent for older providers', () => {
  const stamped = projectAgentRecord({
    agent_id: 'engineer', personal_space_id: 'space-a', profile,
    work_status: 'running', current_task_id: 'task-a',
    current_task_running_since: '2026-10-17T01:00:00Z',
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-17T03:00:00Z'
  });
  assert.equal(stamped.currentTaskRunningSince, '2026-10-17T01:00:00Z');

  const older = projectAgentRecord({
    agent_id: 'engineer', personal_space_id: 'space-a', profile,
    work_status: 'running', current_task_id: 'task-a',
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-17T03:00:00Z'
  });
  assert.equal(Object.hasOwn(older, 'currentTaskRunningSince'), false);
});

test('task participants report a missing run start as null, not the update time', () => {
  const participant = projectAgentTaskParticipantRecord({
    agent_id: 'engineer', role: 'lead', status: 'running',
    joined_at: '2026-10-17T00:00:00Z', updated_at: '2026-10-17T03:00:00Z'
  });
  assert.equal(participant.runningSince, null);
  assert.equal(projectAgentTaskParticipantRecord({
    agent_id: 'engineer', role: 'lead', status: 'running', running_since: '2026-10-17T01:00:00Z'
  }).runningSince, '2026-10-17T01:00:00Z');
});
