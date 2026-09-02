import assert from 'node:assert/strict';
import test from 'node:test';

import { listAgentTools } from '../src/agent-tools.js';
import {
  projectAgentActivityRecord,
  projectAgentExecutionSummary,
  projectAgentTaskEventRecord,
  providerProjectAgentTaskActivity
} from '../src/graphiti/project-agent-mapping.js';

const workerRuntime = {
  application: 'claude_code',
  sessionId: 'worker-session',
  sessionUrl: 'https://example.invalid/sessions/worker-session'
};
const providerRuntime = {
  application: 'claude_code',
  session_id: workerRuntime.sessionId,
  session_url: workerRuntime.sessionUrl
};

test('task activity exposes optional bounded worker runtime, not another source override', () => {
  const tool = listAgentTools().find(({ name }) => name === 'record_project_agent_task_activity');
  const schema = tool.inputSchema.properties.workerRuntime;
  assert.deepEqual(schema.type, ['object', 'null']);
  assert.deepEqual(schema.required, ['application']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.sessionId.maxLength, 256);
  assert.equal(schema.properties.sessionUrl.maxLength, 2048);
  assert.ok(schema.properties.application.enum.includes('claude_code'));
  assert.ok(!tool.inputSchema.required.includes('workerRuntime'));
});

for (const [caseName, runtimeInput] of Object.entries({
  camel: { workerRuntime }, snake: { worker_runtime: providerRuntime }
})) {
  test(`activity maps ${caseName} worker runtime without rewriting host identity`, () => {
    const result = providerProjectAgentTaskActivity({
      sourceApplication: 'codex', sourceSessionId: 'reporter-session',
      workerId: 'worker-a', ...runtimeInput
    });
    assert.equal(result.source_application, 'codex');
    assert.equal(result.source_session_id, 'reporter-session');
    assert.deepEqual(result.worker_runtime, providerRuntime);
    assert.equal(result.actual_model, null);
    assert.equal(result.actual_executor_id, null);
  });
}

const projections = {
  event: projectAgentTaskEventRecord,
  summary: (entry) => projectAgentExecutionSummary([entry])[0],
  activity: (entry) => projectAgentActivityRecord({ days: [{ tasks: [entry] }] }).days[0].tasks[0]
};

for (const [name, project] of Object.entries(projections)) {
  test(`${name} preserves worker runtime separately from reporting session`, () => {
    const result = project({
      source_application: 'codex', source_session_id: 'reporter-session',
      worker_runtime: providerRuntime,
      token_usage: { source: 'executor', total_tokens: 0 }, tools_used: []
    });
    assert.deepEqual(result.workerRuntime, workerRuntime);
    assert.equal(result.sourceApplication, 'codex');
    assert.equal(result.sourceSessionId, 'reporter-session');
    assert.equal(result.tokenUsage.totalTokens, 0);
    assert.deepEqual(result.toolsUsed, []);
  });

  test(`${name} retains legacy absence and explicit null without synthesizing worker metadata`, () => {
    assert.equal(Object.hasOwn(project({}), 'workerRuntime'), false);
    assert.equal(project({ worker_runtime: null }).workerRuntime, null);
    assert.deepEqual(project({ workerRuntime }).workerRuntime, workerRuntime);
  });
}

test('activity input retains null and absent worker metadata distinctly', () => {
  assert.equal(Object.hasOwn(providerProjectAgentTaskActivity({}), 'worker_runtime'), false);
  assert.equal(providerProjectAgentTaskActivity({ workerRuntime: null }).worker_runtime, null);
});
