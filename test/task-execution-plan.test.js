import test from 'node:test';
import assert from 'node:assert/strict';
import { listAgentTools } from '../src/agent-tools.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';
import { providerProjectAgentTaskActivity, projectAgentTaskEventRecord } from '../src/graphiti/project-agent-mapping.js';

const plan = { steps: [{ id: 'verify', title: 'Verify the result', status: 'in_progress' }] };
const activity = { personalSpaceId: 'space', personalProjectId: 'project', taskId: 'task',
  idempotencyKey: 'synthetic-plan-1', agentId: 'lead', status: 'running', summary: 'Verification started.' };

test('task activity accepts an optional explicit plan without requiring a plan for ordinary work', () => {
  const tool = listAgentTools().find(item => item.name === 'record_project_agent_task_activity');
  const schema = jsonSchemaToZod(tool.inputSchema);
  assert.equal(schema.safeParse(activity).success, true);
  assert.deepEqual(schema.parse({ ...activity, executionPlan: plan }).executionPlan, plan);
  assert.equal(schema.safeParse({ ...activity, executionPlan: { steps: [{ ...plan.steps[0], status: 'invented' }] } }).success, false);
});

test('plan snapshots survive request and event mappings, including explicit withdrawal', () => {
  for (const executionPlan of [plan, { steps: [] }]) {
    assert.deepEqual(providerProjectAgentTaskActivity({ ...activity, executionPlan }).execution_plan, executionPlan);
    assert.deepEqual(projectAgentTaskEventRecord({ execution_plan: executionPlan }).executionPlan, executionPlan);
  }
  assert.equal(providerProjectAgentTaskActivity(activity).execution_plan, undefined);
});
