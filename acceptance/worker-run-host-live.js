import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { createWorkerRunAttempt } from '../src/graphiti/worker-run-host.js';
import { createWorkerPlanHost, workerRuntimeBindingKey } from '../src/graphiti/worker-plan-host.js';

// Launched only by the opt-in disposable Provider/Neo4j pytest fixture.
// No native Agent, authentication or model execution is claimed by this adapter.
const fixture = JSON.parse(process.env.FULI_WORKER_HOST_FIXTURE);
const provider = new GraphitiProviderClient({ baseUrl: fixture.providerUrl, accessToken: fixture.accessToken });
let sessionId = `synthetic-host-child-${fixture.scope.personal_space_id}`, startCount = 0, latestRequest;
const prepare = provider.prepareProjectAgentWorkerRun.bind(provider);
provider.prepareProjectAgentWorkerRun = input => { latestRequest = input; return prepare(input); };
const leases = { acquireGraphLease: async () => ({ enabled: false, leaseId: null }),
  releaseLease: async () => ({ released: false }) };
const workerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR'].includes(key.toUpperCase())));
let ownToken, descriptor, childClient, transport, childStderr = '', promptCount = 0, stopped = false;
const adapter = { application: 'codex', async start(input) {
  startCount++;
  if (fixture.retryPlan) sessionId = `synthetic-retry-${startCount}-${fixture.scope.personal_space_id}`;
  descriptor = input.descriptor;
  assert.equal(JSON.stringify(input).includes(fixture.request.task_context_token), false);
  return {
    newSession: async () => ({ sessionId }),
    configure: async () => {
      if (fixture.retryPlan && startCount < 3) throw Object.assign(new Error('Synthetic pre-prompt network interruption'), { code: 'worker_connection_closed' });
      return { modelId: fixture.request.model }; // Synthetic ACK, no real model.
    },
    async promptOnce() {
      promptCount++;
      childClient = new Client({ name: 'synthetic-worker-host-acceptance', version: '1' });
      transport = new StdioClientTransport({ command: process.execPath,
        args: [resolve('src/mcp-server.js'), '--worker', '--runtime-config', fixture.configPath],
        cwd: process.cwd(), stderr: 'pipe', env: { ...workerEnv, FULI_WORKER_DESCRIPTOR: JSON.stringify(descriptor) } });
      transport.stderr?.on('data', chunk => { childStderr += chunk; });
      await childClient.connect(transport);
      const tools = (await childClient.listTools()).tools.map(tool => tool.name).sort();
      assert.deepEqual(tools, ['checkpoint_task_knowledge', 'get_collaboration_preferences']);
      const entry = await childClient.callTool({ name: 'get_collaboration_preferences', arguments: {
        projectPath: fixture.projectPath, sessionId: 'forged-parent-session' } });
      assert.notEqual(entry.isError, true, 'Synthetic worker MCP entry failed');
      ownToken = entry.structuredContent.taskContextToken;
      assert.notEqual(ownToken, fixture.request.task_context_token);
      const context = await provider.getTaskContext(ownToken, {
        personal_space_id: fixture.scope.personal_space_id, source_application: 'codex' });
      assert.equal(context.session_id, sessionId);
      assert.equal(context.project_agent_id, fixture.request.agent_id);
      assert.equal(context.turn_id, `worker-run:${descriptor.runId}`);
      const checkpoint = await childClient.callTool({ name: 'checkpoint_task_knowledge', arguments: {
        taskContextToken: ownToken, disposition: 'retain_nothing', reason: 'Synthetic host lifecycle acceptance only.',
        workLog: { status: 'completed', summary: 'Synthetic adapter result; actual Provider checkpoint and activity verified.' }
      } });
      assert.notEqual(checkpoint.isError, true, 'Synthetic worker MCP checkpoint failed');
      assert.equal(checkpoint.structuredContent.status, 'checkpointed');
      return { sessionId, text: 'Synthetic adapter/model result only.', stopReason: 'end_turn' };
    },
    async close() { await childClient?.close(); stopped = true; }
  };
} };
const attempt = fixture.retryPlan ? null : createWorkerRunAttempt({ provider, leases, adapter,
  request: fixture.request, capability: fixture.capability, projectPath: fixture.projectPath,
  taskPrompt: 'Run one bounded synthetic host lifecycle fixture; do not claim real model execution.',
  toolNames: ['get_collaboration_preferences', 'checkpoint_task_knowledge'] });
let result;
if (fixture.retryPlan) {
  const r = fixture.request, task = { taskId: r.task_id, leadAgentId: r.agent_id,
    participants: [{ agentId: r.agent_id }], status: 'queued', sourceApplication: r.source_application,
    objective: 'Synthetic safe pre-prompt retry and own checkpoint.', selectedExecutorId: r.executor_id,
    executorDecision: { status: 'selected', personal_space_id: r.personal_space_id, personal_project_id: r.personal_project_id,
      task_id: r.task_id, agent_id: r.agent_id, selected_executor_id: r.executor_id, selected_provider: r.provider,
      selected_model: r.model, model_strategy: r.model_strategy } };
  const host = createWorkerPlanHost({ provider, leases, workerRuntimeBindings: new Map([
    [workerRuntimeBindingKey(r.personal_space_id, r.personal_project_id, r.executor_id),
      { adapter, projectPath: fixture.projectPath, leaseExecutor: false }]]) });
  const started = Date.now();
  try {
    result = await host.dispatch({ plan: { ...fixture.scope, host_execution_required: true, route: { task },
      task_context: { task_context_token: r.task_context_token },
      worker_plan: [{ agent_id: r.agent_id, participant_role: 'lead', context_status: 'ready' }] },
      idempotencyKey: 'synthetic-real-provider-retry' });
  } finally { await host.close(); }
  assert.equal(result.attempts.length, 3);
  assert.equal(startCount, 3);
  assert.ok(Date.now() - started >= 4900, 'Actual configured five-second final backoff was not observed');
} else result = await attempt.run();
assert.deepEqual(result.outcome, { status: 'completed', code: 'worker_checkpoint_completed' });
assert.equal(promptCount, 1);
assert.equal(stopped, true);
assert.equal(result.reporting.terminalRecorded, true);
assert.deepEqual(result.cleanup, { processStopped: true, runClosed: true, errors: [] });
assert.equal(result.checkpoint.workLog.status, 'completed');
assert.equal(childStderr.includes(fixture.capability), false);
assert.equal(JSON.stringify(result).includes(fixture.capability), false);
const history = await provider.listProjectAgentTaskRuns({ personalSpaceId: fixture.scope.personal_space_id,
  personalProjectId: fixture.scope.personal_project_id, taskId: fixture.request.task_id });
const closed = fixture.retryPlan ? history.runs.find(run => run.run_id === result.runId)
  : await provider.getProjectAgentWorkerRun(result.runId, fixture.scope, { capability: fixture.capability });
assert.equal(closed.state, 'closed');
assert.equal(closed.actual_session_id, sessionId);
if (!fixture.retryPlan) assert.equal(closed.own_context_token, ownToken);
assert.equal(closed.execution_status, 'completed');
assert.equal(closed.execution_result.retry_eligible, false);
assert.equal(history.runs.length, fixture.retryPlan ? 3 : 1);
if (fixture.retryPlan) {
  assert.deepEqual(history.runs.map(run => run.attempt_number), [1, 2, 3]);
  assert.deepEqual(history.runs.map(run => run.execution_status), ['failed', 'failed', 'completed']);
  assert.equal(new Set(history.runs.map(run => run.root_run_id)).size, 1);
  for (const run of history.runs.slice(0, 2)) {
    assert.equal(run.execution_result.prompt_dispatched, false);
    assert.equal(run.execution_result.process_stopped, true);
    assert.equal(run.execution_result.run_closed, true);
    assert.equal(run.execution_result.failure_class, 'network');
  }
  assert.ok(Date.parse(history.runs[2].created_at) >= Date.parse(history.runs[1].execution_result.retry_not_before));
}
assert.equal(JSON.stringify(history).includes('runtime_capability_hash'), false);
const verified = await provider.verifyTaskCheckpoint({ personal_space_id: fixture.scope.personal_space_id,
  source_application: 'codex', session_id: sessionId });
assert.equal(verified.status, 'checkpointed');
const parent = await provider.getTaskContext(fixture.request.task_context_token, {
  personal_space_id: fixture.scope.personal_space_id, source_application: 'codex' });
assert.equal(parent.checkpoint, null);
assert.equal(parent.session_id, 'worker-parent-session');
const task = await provider.viewProjectAgentTask(fixture.scope.personal_space_id, fixture.request.task_id,
  { personalProjectId: fixture.scope.personal_project_id });
assert.equal(task.status, 'awaiting_review');
const events = task.events.filter(event => event.worker_id === latestRequest.worker_id);
assert.deepEqual(events.map(event => [event.status, event.worker_status]), [['running', 'running'], ['awaiting_review', 'completed']]);
const worker = task.execution_summary.find(value => value.worker_id === latestRequest.worker_id);
assert.equal(worker.status, 'completed');
assert.equal(worker.worker_runtime.session_id, sessionId);
assert.equal(worker.source_session_id, parent.session_id);
for (const field of ['actual_model', 'actual_model_provider', 'executor_id', 'token_usage']) assert.equal(worker[field], null);
console.log(JSON.stringify({ actualProvider: true, actualNeo4j: true, syntheticModel: true,
  ownCheckpoint: true, parentUnchanged: true, terminalWorkerActivity: true, coordinationAwaitingReview: true, runClosed: true }));
