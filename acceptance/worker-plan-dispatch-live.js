import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

// Opt in only against a separately launched disposable Provider/Neo4j pair.
// The actual Windows CLI/process/MCP stack runs; the ACP peer/model are synthetic.
assert.equal(process.platform, 'win32');
assert.equal(process.env.FULI_TEST_NEO4J_EPHEMERAL, '1');
const providerUrl = process.env.FULI_WORKER_PLAN_PROVIDER_URL;
assert.equal(new URL(providerUrl).hostname, '127.0.0.1');
const root = await mkdtemp(join(tmpdir(), 'fuli-worker-plan-live-'));
const fixtureId = randomUUID();
let accessToken;
async function api(path, body, method = 'POST') {
  const response = await fetch(`${providerUrl}${path}`, { method, headers: { 'content-type': 'application/json',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : { 'x-fuli-bootstrap-token': 'synthetic-worker-plan-bootstrap-1234' }) },
  ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  assert.equal(response.ok, true, `Disposable Provider rejected ${path}: ${response.status}`);
  return response.json();
}
async function observed(path, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
    if (value && predicate(value)) return value;
    await delay(50);
  }
  throw new Error('Synthetic CLI observation timed out');
}
function dispatch(args, request) {
  const child = spawn(process.execPath, ['src/cli.js', 'worker', 'dispatch', ...args],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  const completion = new Promise((resolveResult, reject) => {
    child.on('error', reject);
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('close', code => resolveResult({ code, stdout, stderr }));
  });
  child.stdin.end(JSON.stringify(request));
  return { child, completion };
}
try {
  accessToken = (await api('/v1/bootstrap', { principal_name: 'Synthetic worker plan CLI' })).access_token;
  const space = await api('/v1/spaces', { name: `Synthetic worker plan CLI ${fixtureId}`, kind: 'personal' });
  const scope = { personal_space_id: space.id, personal_project_id: 'synthetic-worker-plan-project' };
  await api('/v1/personal-projects', { personal_space_id: space.id, project_id: scope.personal_project_id,
    profile: { name: 'Synthetic worker dispatch project', lifecycle: 'active' } }, 'PUT');
  for (const agent_id of ['owner', 'specialist']) {
    await api('/v1/project-agents', { ...scope, agent_id, profile: { name: `Synthetic ${agent_id}`,
      responsibility: 'Disposable CLI acceptance.', allowed_clients: ['codex'], work_kinds: ['implementation'], capabilities: ['coding'] } }, 'PUT');
  }
  await api('/v1/project-agent-coordination-policy', { ...scope, team_lead_agent_id: 'owner', team_member_agent_ids: ['specialist'] }, 'PUT');
  await api('/v1/executors', { personal_space_id: space.id, executor_id: 'synthetic-executor', display_name: 'Synthetic executor',
    capabilities: ['coding'], idempotency_key: 'synthetic-register' }, 'PUT');
  await api('/v1/executors/authorization', { personal_space_id: space.id, executor_id: 'synthetic-executor',
    status: 'authorized', reason: 'Disposable synthetic acceptance only.', idempotency_key: 'synthetic-authorize' });
  await api('/v1/executors/preflight', { personal_space_id: space.id, executor_id: 'synthetic-executor', status: 'passed',
    workspace_permission: true, capabilities: ['coding'], available_models: [{ provider: 'synthetic', model: 'synthetic-model',
      capabilities: ['coding'], reasoning_efforts: ['max'] }],
    checked_at: new Date().toISOString(), idempotency_key: 'synthetic-preflight' });
  const config = { version: 1, workspaces: [], personal: { providerUrl, accessToken, principalId: 'synthetic-cli', spaceId: space.id } };
  const configPath = join(root, 'graph-runtime.json');
  // Only the disposable fixture token is used; no installed credential is read.
  await writeFile(configPath, JSON.stringify(config));
  const app = new FederatedGraphApplication(config);
  for (const kind of ['completed', 'revoked', 'unbound']) {
    const projectPath = join(root, kind), codexHome = join(root, `${kind}-isolated-home`);
    await mkdir(projectPath); await mkdir(codexHome);
    // Pre-provision only this disposable test home, as in the ACP process tests.
    // The dispatch command itself never creates or changes a trust record.
    await writeFile(join(codexHome, 'config.toml'), `[projects.${JSON.stringify(projectPath)}]\ntrust_level = "trusted"\n`);
    await writeFile(join(projectPath, 'synthetic-mode.json'), JSON.stringify({ sessionId: `synthetic-${kind}-${fixtureId}`, hang: kind === 'revoked' }));
    const parent = await app.taskContextRegistry.begin({ personalProjectId: scope.personal_project_id, projectAgentId: 'owner',
      sessionId: `synthetic-parent-${kind}-${fixtureId}`, sourceApplication: 'codex' });
    const plan = await app.coordinateProjectAgentTask({ personalProjectId: scope.personal_project_id, projectPath,
      taskContextToken: parent.token, title: 'Synthetic CLI dispatch', objective: 'Exercise one synthetic CLI worker.',
      workKind: 'implementation', duration: 'one_off', staffingIntent: 'reuse_preferred', leadAgentId: 'specialist',
      coordinatorAgentId: 'owner', idempotencyKey: `synthetic-coordinate-${kind}`, sourceApplication: 'codex',
      sourceSessionId: parent.sessionId, routingReason: 'Disposable actual CLI acceptance.', contextQueries: ['worker dispatch'],
      modelStrategyOverride: { mode: 'deep', reasoningEffort: 'max', capabilityHints: [] } });
    assert.equal(plan.worker_plan.length, 1);
    assert.equal(plan.worker_plan[0].context_status, 'ready');
    assert.equal(plan.host_execution_required, true, JSON.stringify({ status: plan.status,
      taskStatus: plan.route.task.status, decision: plan.route.task.executorDecision }));
    assert.equal(plan.task_context.task_context_token, parent.token);
    const bindingPath = join(root, `${kind}-bindings.json`);
    await writeFile(bindingPath, JSON.stringify({ version: 1, bindings: kind === 'unbound' ? [] : [{ personalSpaceId: space.id,
      personalProjectId: scope.personal_project_id, executorId: 'synthetic-executor', application: 'codex', projectPath,
      codexHome, adapterPath: resolve('acceptance/fixtures/worker-plan-acp.js'), codexPath: process.execPath, leaseExecutor: false }] }));
    const execution = dispatch(['--bindings', bindingPath, '--runtime-config', configPath], { plan, idempotencyKey: `synthetic-dispatch-${kind}` });
    let timer;
    try {
      if (kind === 'revoked') {
        const value = await observed(join(projectPath, 'synthetic-observed.json'), value => value.promptStarted);
        await api(`/v1/project-agent-worker-runs/${value.runId}/revoke`, { ...scope, reason: 'Synthetic out-of-band revocation.' });
      }
      const output = await Promise.race([execution.completion, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Actual CLI timeout')), 60_000);
      })]);
      assert.equal(output.stderr, '');
      assert.equal(output.stdout.includes(parent.token), false);
      assert.equal(output.stdout.includes(accessToken), false);
      const result = JSON.parse(output.stdout);
      assert.equal(result.outcome.status, kind === 'revoked' ? 'cancelled' : kind === 'unbound' ? 'blocked' : 'completed', output.stdout);
      assert.equal(output.code, kind === 'revoked' ? 130 : kind === 'unbound' ? 2 : 0);
      if (kind !== 'unbound') {
        assert.equal(result.cleanup.processStopped, true);
        assert.equal(result.cleanup.runClosed, true);
        assert.deepEqual(result.cleanup.errors, []);
        const value = await observed(join(projectPath, 'synthetic-observed.json'), value => value.runId);
        assert.throws(() => process.kill(value.pid, 0), /ESRCH/);
        const task = await app.personal.viewProjectAgentTask(space.id, plan.route.task.taskId, { personalProjectId: scope.personal_project_id });
        assert.equal(task.status, 'running');
        assert.equal(task.execution_summary.length, 1);
        assert.equal(task.execution_summary[0].status, kind === 'revoked' ? 'cancelled' : 'completed');
        assert.equal(task.execution_summary[0].actual_model, null);
      }
      const unchanged = await app.taskContextRegistry.context(parent.token, 'codex');
      assert.equal(unchanged.projectAgentId, 'owner');
      assert.equal(unchanged.checkpoint, null);
    } finally {
      clearTimeout(timer);
      if (execution.child.exitCode === null) execution.child.kill();
      await execution.completion;
    }
  }
  console.log(JSON.stringify({ actualCli: true, actualCoordination: true, actualProvider: true, actualNeo4j: true,
    syntheticAdapterAndModel: true, ownCheckpoint: true, unboundBlocked: true, outOfBandCancellation: true,
    processCleanup: true, parentOwnerPreserved: true, parentNotCompleted: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
