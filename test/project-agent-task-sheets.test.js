import assert from 'node:assert/strict';
import test from 'node:test';
import { listAgentWorkbenches, listTeamWorkbenches, taskSheet } from '../src/graphiti/project-agent-task-sheets.js';
import { projectAgentTaskEventRecord, providerProjectAgentTaskActivity } from '../src/graphiti/project-agent-mapping.js';

// Synthetic tasks only (rec#11 D-82).
const plan = (createdAt, steps) => ({ createdAt, executionPlan: { steps } });
const task = (overrides = {}) => ({
  taskId: 't1', personalProjectId: 'garden', title: 'Plant the beds', objective: 'Spring beds', status: 'running',
  leadAgentId: 'lead', coordinatorAgentId: null, updatedAt: '2026-11-01T02:00:00Z',
  participants: [
    { agentId: 'lead', role: 'lead', status: 'running', assignmentSummary: 'Plan and review' },
    { agentId: 'helper', role: 'collaborator', status: 'completed', assignmentSummary: 'Order seeds' }],
  events: [
    plan('2026-11-01T01:00:00Z', [{ id: 'old', title: 'Old', status: 'completed', agentId: 'lead' }]),
    plan('2026-11-01T02:00:00Z', [
      { id: 'a', title: 'Draw the plan', status: 'completed', agentId: 'lead' },
      { id: 'b', title: 'Review', status: 'in_progress', agentId: 'lead' },
      { id: 'c', title: 'Order seeds', status: 'completed', agentId: 'helper' },
      { id: 'd', title: 'Skipped', status: 'skipped', agentId: 'helper' },
      { id: 'e', title: 'Nobody yet', status: 'pending' }]),
    { createdAt: '2026-11-01T03:00:00Z', summary: 'no plan in this event' }],
  ...overrides });

test('a task sheet counts each share from the newest plan and never invents a number', () => {
  const sheet = taskSheet(task(), 'helper');
  assert.equal(sheet.role, 'collaborator');
  assert.deepEqual(sheet.progress, { completed: 2, total: 4 });
  assert.equal(sheet.unassignedSteps, 1);
  assert.deepEqual(sheet.shares.map(share => share.currentStepId), ['b', null]);
  assert.deepEqual(sheet.shares.map(share => [share.agentId, share.status, share.assignment, share.progress]), [
    ['lead', 'running', 'Plan and review', { completed: 1, total: 2 }],
    ['helper', 'completed', 'Order seeds', { completed: 1, total: 1 }]]);
  // No plan, or a withdrawn one: statuses only, no progress.
  const withdrawn = taskSheet(task({ events: [plan('2026-11-01T04:00:00Z', [])] }), 'lead');
  assert.equal(withdrawn.progress, null);
  assert.deepEqual(withdrawn.shares.map(share => share.progress), [null, null]);
  assert.equal(taskSheet(task({ events: [] })).progress, null);
});

test('an FLA\'s workbenches are its tasks, cancelled ones left out', async () => {
  const calls = [];
  const app = { listProjectAgentTasks: async input => { calls.push(input);
    return [task(), task({ taskId: 't2', status: 'cancelled' }), task({ taskId: 't3', coordinatorAgentId: 'boss', participants: [] })]; } };
  const result = await listAgentWorkbenches(app, { personalSpaceId: 'space', agentId: 'boss' });
  assert.deepEqual(calls, [{ personalSpaceId: 'space', agentId: 'boss', limit: 200 }]);
  assert.deepEqual(result.workbenches.map(sheet => [sheet.taskId, sheet.role]), [['t1', null], ['t3', 'coordinator']]);
  assert.equal(result.partial, false);
  await assert.rejects(listAgentWorkbenches(app, { personalSpaceId: 'space' }), /agentId is required/);
});

test('team workbenches are the open tasks two or more FLAs share', async () => {
  const solo = task({ taskId: 'solo', participants: [task().participants[0]] });
  const app = { listProjectAgentTasks: async input => {
    assert.deepEqual(input, { personalSpaceId: 'space', limit: 200 });
    return [task(), solo, task({ taskId: 'newer', updatedAt: '2026-11-01T05:00:00Z' }),
      task({ taskId: 'done', status: 'completed' }), task({ taskId: 'off', status: 'cancelled' })]; } };
  const result = await listTeamWorkbenches(app, { personalSpaceId: 'space' });
  assert.deepEqual(result.workbenches.map(sheet => sheet.taskId), ['newer', 't1']);
  assert.equal(result.workbenches[0].role, null);
  assert.equal(result.workbenches[0].shares.length, 2);
});

test('a plan step owner travels as agent_id to the Provider and agentId back', () => {
  const sent = providerProjectAgentTaskActivity({ executionPlan: { steps: [
    { id: 'a', title: 'A', status: 'pending', agentId: 'lead' }, { id: 'b', title: 'B', status: 'pending' }] } });
  assert.deepEqual(sent.execution_plan.steps, [
    { id: 'a', title: 'A', status: 'pending', agent_id: 'lead' }, { id: 'b', title: 'B', status: 'pending' }]);
  const read = projectAgentTaskEventRecord({ event_id: 'e', task_id: 't', status: 'running', execution_plan: sent.execution_plan });
  assert.deepEqual(read.executionPlan.steps, [
    { id: 'a', title: 'A', status: 'pending', agentId: 'lead' }, { id: 'b', title: 'B', status: 'pending' }]);
});
