import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { runWorkerCommand } from '../src/cli/worker-command.js';
import { createWorkerPlanRuntime } from '../src/server/worker-plan-runtime.js';
import { workerRuntimeBindingKey } from '../src/graphiti/worker-plan-host.js';
import { createServer } from '../src/server.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fuli-worker-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeConfigPath = join(root, 'graph-runtime.json'), bindingsPath = join(root, 'bindings.json');
  await writeFile(runtimeConfigPath, JSON.stringify({ version: 1, workspaces: [], personal: {
    providerUrl: 'http://127.0.0.1:1', accessToken: 'synthetic-not-a-real-credential', principalId: 'test', spaceId: 'space' } }));
  await writeFile(bindingsPath, JSON.stringify({ version: 1, bindings: [] }));
  return { root, runtimeConfigPath, bindingsPath };
}
function runCli(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', 'worker', ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const argsFor = f => ['dispatch', '--bindings', f.bindingsPath, '--runtime-config', f.runtimeConfigPath];

test('real CLI rejects an unbound ready plan with exit 2 and never echoes its parent token', async t => {
  const f = await fixture(t);
  const plan = { personal_space_id: 'space', personal_project_id: 'project', host_execution_required: true,
    task_context: { task_context_token: 'fuli-task-private-parent-1234' },
    worker_plan: [{ agent_id: 'lead', participant_role: 'lead', context_status: 'ready' }],
    route: { task: { taskId: 'task', leadAgentId: 'lead', status: 'queued', participants: [{ agentId: 'lead' }],
      selectedExecutorId: 'native', executorDecision: { status: 'selected', personal_space_id: 'space',
        personal_project_id: 'project', task_id: 'task', agent_id: 'lead', selected_executor_id: 'native',
        selected_provider: 'synthetic', selected_model: 'synthetic', model_strategy: {} } } } };
  const result = await runCli(argsFor(f), JSON.stringify({ plan, idempotencyKey: 'synthetic-dispatch' }));
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).outcome.code, 'worker_runtime_unbound');
  assert.equal((result.stdout + result.stderr).includes(plan.task_context.task_context_token), false);
});

test('real CLI bounds stdin and rejects malformed configuration without diagnostic reflection', async t => {
  const f = await fixture(t);
  const secret = 'SYNTHETIC_PRIVATE_INPUT_NEVER_ECHO';
  for (const input of [secret, JSON.stringify({ plan: secret.repeat(40_000) })]) {
    const result = await runCli(argsFor(f), input);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).outcome.code, 'worker_dispatch_failed');
    assert.equal((result.stdout + result.stderr).includes(secret), false);
  }
  await writeFile(f.bindingsPath, JSON.stringify({ version: 1, bindings: [], accessToken: secret }));
  assert.equal((await runCli(argsFor(f), '{}')).code, 1);
});

test('CLI SIGINT is delivered to the existing dispatch signal and runtime is closed before output', async t => {
  const f = await fixture(t), signals = new EventEmitter(), events = [];
  const result = await runWorkerCommand(argsFor(f), { signals, input: Readable.from(['{"plan":{},"idempotencyKey":"dispatch-1"}']),
    createRuntime: async () => ({ host: { dispatch: async ({ signal }) => {
      assert.equal(signal.aborted, false);
      signals.emit('SIGINT');
      assert.equal(signal.aborted, true);
      events.push('cancelled');
      return { runId: 'run', outcome: { status: 'cancelled', code: 'worker_cancelled' }, result: { text: 'PRIVATE' } };
    } }, close: async () => { events.push('closed'); } }), write: output => {
      events.push('written'); assert.equal(output.includes('PRIVATE'), false);
    } });
  assert.equal(result.exitCode, 130);
  assert.deepEqual(events, ['cancelled', 'closed', 'written']);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('trusted runtime rejects daily home, unknown fields, missing paths and mismatched scope keys', async t => {
  const f = await fixture(t), projectPath = join(f.root, 'workspace'), codexHome = join(f.root, 'isolated-home');
  await mkdir(projectPath); await mkdir(codexHome);
  const binding = { personalSpaceId: 'space', personalProjectId: 'project', executorId: 'native', application: 'codex',
    projectPath, codexHome, adapterPath: process.execPath, codexPath: process.execPath, leaseExecutor: false };
  const key = workerRuntimeBindingKey('space', 'project', 'native');
  const create = (value, options = {}) => createWorkerPlanRuntime({ runtimeConfigPath: f.runtimeConfigPath,
    workerRuntimeBindings: new Map([[key, value]]), provider: {}, leases: {}, ...options });
  for (const value of [{ ...binding, personalProjectId: 'foreign' }, { ...binding, codexPath: 'relative.exe' },
    { ...binding, adapterPath: join(f.root, 'missing.js') }, { ...binding, accessToken: 'PRIVATE' }]) {
    await assert.rejects(() => create(value));
  }
  await assert.rejects(() => create(binding, { env: { CODEX_HOME: codexHome } }));
  const runtime = await create(binding, { env: {} });
  await runtime.close();
});

test('server composition exposes only the explicit local host and closes it with the server', async t => {
  const f = await fixture(t);
  const server = await createServer({ app: { personal: {}, close() {} }, port: 0,
    runtimeConfigPath: f.runtimeConfigPath, workerRuntimeBindings: new Map(), workerRuntimeLeases: {} });
  try {
    assert.equal((await server.workerPlanHost.dispatch({ plan: {} })).outcome.code, 'worker_plan_unsupported');
  } finally { await server.close(); }
  assert.equal((await server.workerPlanHost.dispatch({ plan: {} })).outcome.code, 'worker_host_closed');
});
