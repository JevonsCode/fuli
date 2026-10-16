import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { createWorkerRunAttempt } from '../src/graphiti/worker-run-host.js';

// Launched only by the opt-in disposable Provider/Neo4j pytest fixture.
// No native Agent, authentication or model execution is claimed by this adapter.
const fixture = JSON.parse(process.env.FULI_WORKER_HOST_FIXTURE);
const provider = new GraphitiProviderClient({ baseUrl: fixture.providerUrl, accessToken: fixture.accessToken });
const sessionId = `synthetic-host-child-${fixture.scope.personal_space_id}`;
const leases = { acquireGraphLease: async () => ({ enabled: false, leaseId: null }),
  releaseLease: async () => ({ released: false }) };
const workerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR'].includes(key.toUpperCase())));
let ownToken, descriptor, childClient, transport, childStderr = '', promptCount = 0, stopped = false;
const adapter = { application: 'codex', async start(input) {
  descriptor = input.descriptor;
  assert.equal(JSON.stringify(input).includes(fixture.request.task_context_token), false);
  return {
    newSession: async () => ({ sessionId }),
    configure: async () => ({ modelId: fixture.request.model }), // Synthetic ACK, no real model.
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
const attempt = createWorkerRunAttempt({ provider, leases, adapter,
  request: fixture.request, capability: fixture.capability, projectPath: fixture.projectPath,
  taskPrompt: 'Run one bounded synthetic host lifecycle fixture; do not claim real model execution.',
  toolNames: ['get_collaboration_preferences', 'checkpoint_task_knowledge'] });
const result = await attempt.run();
assert.deepEqual(result.outcome, { status: 'completed', code: 'worker_checkpoint_completed' });
assert.equal(promptCount, 1);
assert.equal(stopped, true);
assert.equal(result.reporting.terminalRecorded, true);
assert.deepEqual(result.cleanup, { processStopped: true, runClosed: true, errors: [] });
assert.equal(result.checkpoint.workLog.status, 'completed');
assert.equal(childStderr.includes(fixture.capability), false);
assert.equal(JSON.stringify(result).includes(fixture.capability), false);
const closed = await provider.getProjectAgentWorkerRun(result.runId, fixture.scope, { capability: fixture.capability });
assert.equal(closed.state, 'closed');
assert.equal(closed.actual_session_id, sessionId);
assert.equal(closed.own_context_token, ownToken);
const verified = await provider.verifyTaskCheckpoint({ personal_space_id: fixture.scope.personal_space_id,
  source_application: 'codex', session_id: sessionId });
assert.equal(verified.status, 'checkpointed');
const parent = await provider.getTaskContext(fixture.request.task_context_token, {
  personal_space_id: fixture.scope.personal_space_id, source_application: 'codex' });
assert.equal(parent.checkpoint, null);
assert.equal(parent.session_id, 'worker-parent-session');
const task = await provider.viewProjectAgentTask(fixture.scope.personal_space_id, fixture.request.task_id,
  { personalProjectId: fixture.scope.personal_project_id });
assert.equal(task.status, 'running');
const events = task.events.filter(event => event.worker_id === fixture.request.worker_id);
assert.deepEqual(events.map(event => [event.status, event.worker_status]), [['running', 'running'], ['running', 'completed']]);
const worker = task.execution_summary.find(value => value.worker_id === fixture.request.worker_id);
assert.equal(worker.status, 'completed');
assert.equal(worker.worker_runtime.session_id, sessionId);
assert.equal(worker.source_session_id, parent.session_id);
for (const field of ['actual_model', 'actual_model_provider', 'executor_id', 'token_usage']) assert.equal(worker[field], null);
console.log(JSON.stringify({ actualProvider: true, actualNeo4j: true, syntheticModel: true,
  ownCheckpoint: true, parentUnchanged: true, terminalWorkerActivity: true, coordinationStillRunning: true, runClosed: true }));
