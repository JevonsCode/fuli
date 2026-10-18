import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createWorkerRunAttempt } from '../src/graphiti/worker-run-host.js';

const capability = 'synthetic-private-capability-never-log-1234';
const parentToken = 'fuli-task-synthetic-parent-1234';
const ownToken = 'fuli-task-synthetic-child-5678';
const request = { personal_space_id: 'space', personal_project_id: 'project', task_context_token: parentToken,
  source_application: 'claude_code', task_id: 'task', agent_id: 'worker-agent', worker_id: 'worker-1',
  executor_id: 'native-executor', target_application: 'codex', provider: 'openai', model: 'gpt-6.1-sol',
  model_strategy: { mode: 'deep', reasoning_effort: 'max', capability_hints: [] }, idempotency_key: 'attempt-1234' };

function fixture(options = {}) {
  const calls = [], activities = [];
  let prompted = false;
  const parent = { token: parentToken, personal_space_id: 'space', personal_project_id: 'project',
    project_agent_id: 'parent-agent', session_id: 'parent-native-session', source_application: 'claude_code' };
  const context = { token: ownToken, personal_space_id: 'space', personal_project_id: 'project',
    project_agent_id: 'worker-agent', session_id: 'child-native-session', source_session_id: 'child-native-session',
    source_application: 'codex', turn_id: 'worker-run:run-1' };
  const view = (state, extra = {}) => ({ run_id: 'run-1', state, ...Object.fromEntries(
    ['personal_space_id', 'personal_project_id', 'task_id', 'agent_id', 'worker_id', 'executor_id',
      'target_application'].map(key => [key, request[key]])),
  requested_model_provider: request.provider, requested_model: request.model,
  requested_model_strategy: structuredClone(request.model_strategy),
  ...(state === 'sealed' || state === 'admitted' || state === 'closed' ? { actual_session_id: context.session_id } : {}), ...extra });
  const checkpoint = { phase: 'complete', work_log: { status: 'completed', summary: 'Synthetic child result with test evidence.' } };
  const provider = {
    async getTaskContext(token, _query, input) {
      calls.push(token === parentToken ? 'parent' : 'checkpoint');
      if (token === parentToken) return { ...parent };
      assert.equal(token, ownToken);
      options.onCheckpoint?.(input);
      return { ...context, checkpoint: prompted ? options.checkpoint === undefined ? checkpoint : options.checkpoint : null };
    },
    async prepareProjectAgentWorkerRun(input) {
      calls.push('prepare');
      assert.equal(input.runtime_capability_hash, createHash('sha256').update(capability).digest('hex'));
      assert.equal(JSON.stringify(input).includes(capability), false);
      return view('prepared');
    },
    async claimProjectAgentWorkerStart() { calls.push('claim'); return view('claimed', { start_claimed: options.claimed !== false }); },
    async getProjectAgentWorkerRun() { return view('admitted'); },
    async dispatchProjectAgentWorkerPrompt() { calls.push('dispatch'); return { dispatch_claimed: true }; },
    async recordProjectAgentWorkerResult(_id, input) {
      calls.push('result'); return { execution_result: { ...input, retry_eligible: false } };
    },
    async sealProjectAgentWorkerSession(_id, input) {
      calls.push('seal'); assert.equal(input.session_id, context.session_id);
      return view('sealed', options.seal ?? {});
    },
    async admitProjectAgentWorkerContext() {
      calls.push('admit'); options.onAdmit?.(calls.filter(value => value === 'admit').length);
      return view('admitted', { own_context_token: ownToken, task_context: { ...context } });
    },
    async closeProjectAgentWorkerRun(_id, _input, options) {
      calls.push('close-run'); assert.equal(options.signal, null); return view('closed');
    },
    async recordProjectAgentTaskActivity(input, options) {
      calls.push(input.worker_status === 'running' ? 'running' : 'terminal');
      assert.equal(options.signal, null);
      activities.push(structuredClone(input));
    }
  };
  const child = {
    async newSession() { calls.push('session'); return { sessionId: context.session_id }; },
    async configure() { calls.push('configure'); options.onConfigure?.(); return { modelId: request.model }; },
    async promptOnce(input) {
      calls.push('prompt');
      assert.match(input.text, /checkpoint_task_knowledge/);
      assert.equal(input.text.includes(parentToken), false);
      options.onPrompt?.(input);
      prompted = true;
      return { sessionId: context.session_id, text: options.text ?? 'Synthetic output.', stopReason: options.stopReason ?? 'end_turn' };
    },
    async close() { calls.push('close-process'); options.onClose?.(); }
  };
  const adapter = { application: 'codex', async start(input) {
    calls.push('start');
    assert.equal(input.descriptor.capability, capability);
    assert.equal(input.descriptor.runId, 'run-1');
    assert.equal(JSON.stringify(input).includes(parentToken), false);
    return child;
  } };
  const leases = {
    async acquireGraphLease() { calls.push('graph-lease'); return { enabled: true, leaseId: 'graph' }; },
    async acquireExecutorLease(id) { calls.push('executor-lease'); assert.equal(id, request.executor_id); return { enabled: true, leaseId: 'executor' }; },
    async releaseLease(handle) { calls.push(`release-${handle.leaseId}`); return { released: true }; }
  };
  const input = { provider, leases, adapter, request, capability, projectPath: process.cwd(), taskPrompt: 'One bounded synthetic task.',
    toolNames: ['get_collaboration_preferences', 'checkpoint_task_knowledge'], leaseExecutor: options.leaseExecutor ?? true };
  return { calls, activities, input, provider, child, adapter, leases, parent, context, checkpoint,
    attempt: createWorkerRunAttempt(input) };
}

test('one host attempt claims once, seals the actual child session and reports its own completed checkpoint', async () => {
  const { attempt, calls, activities } = fixture();
  const first = attempt.run();
  assert.equal(attempt.run(), first);
  const result = await first;
  assert.deepEqual(calls, ['graph-lease', 'executor-lease', 'parent', 'prepare', 'claim', 'start', 'session',
    'seal', 'admit', 'configure', 'admit', 'running', 'dispatch', 'prompt', 'checkpoint', 'close-run', 'close-process',
    'terminal', 'release-executor', 'release-graph', 'result']);
  assert.deepEqual(result.outcome, { status: 'completed', code: 'worker_checkpoint_completed' });
  assert.equal(result.reporting.terminalRecorded, true);
  assert.deepEqual(result.cleanup, { processStopped: true, runClosed: true, errors: [] });
  assert.deepEqual(result.workerRuntime, { application: 'codex', session_id: 'child-native-session' });
  assert.deepEqual(activities.map(value => [value.status, value.worker_status]), [['running', 'running'], ['awaiting_review', 'completed']]);
  for (const activity of activities) {
    assert.equal(activity.source_application, 'claude_code');
    assert.equal(activity.source_session_id, 'parent-native-session');
    assert.equal(activity.token_usage, null);
    for (const name of ['actual_executor_id', 'actual_model', 'actual_model_provider']) assert.equal(Object.hasOwn(activity, name), false);
  }
});

test('a lost or already-owned start claim never launches or closes another host run', async () => {
  for (const lost of [false, true]) {
    const f = fixture({ claimed: false });
    if (lost) f.provider.claimProjectAgentWorkerStart = async () => { throw new Error(capability); };
    const result = await createWorkerRunAttempt(f.input).run();
    assert.equal(f.calls.includes('start'), false);
    assert.equal(f.calls.includes('close-run'), false);
    assert.equal(f.activities.length, 0);
    assert.equal(result.outcome.code, lost ? 'worker_claim_failed' : 'worker_start_not_claimed');
    assert.deepEqual(f.calls.filter(value => value.startsWith('release-')), ['release-executor', 'release-graph']);
    assert.equal(JSON.stringify(result).includes(capability), false);
  }
});

test('model ACK and end_turn without a completed child checkpoint remain awaiting review', async () => {
  for (const checkpoint of [null, { phase: 'prepare' },
    { phase: 'complete', work_log: { status: 'incomplete', summary: 'More evidence is needed.' } },
    { phase: 'complete', work_log: { status: 'reported', summary: 'Reported, pending acceptance.' } }]) {
    const f = fixture({ checkpoint });
    const result = await f.attempt.run();
    assert.equal(result.outcome.status, 'incomplete');
    assert.equal(f.activities.at(-1).worker_status, 'awaiting_review');
    assert.equal(f.activities.at(-1).status, 'running');
  }
});

test('child failure and interrupted turns preserve their checkpoint without claiming completion', async () => {
  const unchanged = fixture({ checkpoint: { phase: 'complete', work_log: { status: 'no_change', summary: 'Verified existing behavior.' } } });
  assert.equal((await unchanged.attempt.run()).outcome.status, 'completed');
  const failed = fixture({ checkpoint: { phase: 'complete', work_log: { status: 'failed', summary: 'Focused command failed.' } } });
  assert.equal((await failed.attempt.run()).outcome.code, 'worker_checkpoint_failed');
  assert.equal(failed.activities.at(-1).worker_status, 'failed');
  const incomplete = fixture({ stopReason: 'max_tokens' });
  const result = await incomplete.attempt.run();
  assert.equal(result.outcome.status, 'incomplete');
  assert.equal(result.checkpoint.workLog.status, 'completed');
});

test('foreign checkpoint identity is rejected even when it claims a completed work log', async () => {
  const f = fixture();
  const read = f.provider.getTaskContext;
  f.provider.getTaskContext = async (...args) => {
    const value = await read(...args);
    return args[0] === ownToken ? { ...value, session_id: 'foreign-session' } : value;
  };
  const result = await createWorkerRunAttempt(f.input).run();
  assert.deepEqual(result.outcome, { status: 'failed', code: 'worker_identity_mismatch' });
  assert.equal(result.checkpoint, null);
  assert.equal(f.activities.at(-1).worker_status, 'failed');
});

test('pre-cancelled work never acquires a lease and bootstrap failures do not invent a worker row', async () => {
  const controller = new AbortController();
  controller.abort(new Error(capability));
  const cancelled = fixture();
  assert.equal((await cancelled.attempt.run({ signal: controller.signal })).outcome.status, 'cancelled');
  assert.deepEqual(cancelled.calls, []);
  for (const code of ['worker_authentication_required', 'worker_authentication_unknown']) {
    const blocked = fixture();
    blocked.adapter.start = async () => { throw Object.assign(new Error(capability), { code }); };
    const result = await createWorkerRunAttempt(blocked.input).run();
    assert.deepEqual(result.outcome, { status: 'blocked', code });
    assert.equal(Object.hasOwn(result, 'workerRuntime'), false);
    assert.equal(blocked.activities.length, 0);
    assert.equal(result.cleanup.runClosed, true);
  }
});

test('session/identity and authority changes prevent prompt dispatch and still close owned resources', async () => {
  for (const kind of ['seal', 'context', 'revoked']) {
    const f = fixture({ ...(kind === 'seal' ? { seal: { actual_session_id: 'foreign' } } : {}),
      ...(kind === 'revoked' ? { onAdmit: count => { if (count === 2) throw new Error(capability); } } : {}) });
    if (kind === 'context') f.context.project_agent_id = 'foreign-agent';
    const result = await f.attempt.run();
    assert.equal(result.outcome.status, 'failed');
    assert.equal(f.calls.includes('prompt'), false);
    assert.equal(f.calls.includes('close-run'), true);
    assert.equal(f.calls.includes('close-process'), true);
    assert.deepEqual(f.calls.filter(value => value.startsWith('release-')), ['release-executor', 'release-graph']);
    assert.equal(JSON.stringify(result).includes(capability), false);
  }
});

test('cancellation after configuration dispatches no prompt and cleanup ignores the aborted signal', async () => {
  const controller = new AbortController();
  const f = fixture({ onConfigure: () => controller.abort(new Error(capability)) });
  const result = await f.attempt.run({ signal: controller.signal });
  assert.equal(result.outcome.status, 'cancelled');
  assert.equal(f.calls.includes('prompt'), false);
  assert.equal(result.cleanup.runClosed, true);
  assert.equal(result.cleanup.processStopped, true);
  assert.equal(f.activities.at(-1).worker_status, 'cancelled');
  assert.equal(JSON.stringify(result).includes(capability), false);
});

test('a rejected seal can close the unsealed run without hiding the original failure or accepting foreign identity', async () => {
  for (const foreign of [false, true]) {
    const f = fixture();
    f.provider.sealProjectAgentWorkerSession = async () => { throw new Error('Synthetic seal rejection'); };
    const close = f.provider.closeProjectAgentWorkerRun;
    f.provider.closeProjectAgentWorkerRun = async (...args) => ({ ...await close(...args), actual_session_id: null,
      ...(foreign ? { task_id: 'foreign-task' } : {}) });
    const result = await createWorkerRunAttempt(f.input).run();
    assert.equal(result.outcome.status, 'failed');
    assert.equal(result.outcome.code, foreign ? 'worker_cleanup_incomplete' : 'worker_seal_failed');
    assert.equal(result.cleanup.runClosed, !foreign);
    assert.equal(result.cleanup.processStopped, true);
    assert.equal(f.calls.includes('prompt'), false);
    assert.deepEqual(result.cleanup.errors, foreign ? ['worker_run_close_failed'] : []);
  }
});

test('process, authority and lease cleanup failures and unrecorded terminal activity stay explicit', async () => {
  for (const kind of ['process', 'run', 'lease', 'report']) {
    const f = fixture({ ...(kind === 'process' ? { onClose: () => { throw new Error(capability); } } : {}) });
    if (kind === 'run') f.provider.closeProjectAgentWorkerRun = async () => { throw new Error(capability); };
    if (kind === 'lease') f.leases.releaseLease = async () => ({ released: false });
    if (kind === 'report') f.provider.recordProjectAgentTaskActivity = async input => {
      if (input.worker_status !== 'running') throw new Error(capability);
    };
    const result = await createWorkerRunAttempt(f.input).run();
    assert.ok(result.cleanup.errors.length > 0);
    assert.equal(result.reporting.terminalRecorded, kind !== 'report');
    if (['process', 'run'].includes(kind)) assert.equal(result.outcome.code, 'worker_cleanup_incomplete');
    else assert.deepEqual(result.outcome, { status: 'incomplete', code: 'worker_host_finalization_incomplete' });
    assert.equal(result.checkpoint.workLog.status, 'completed');
    assert.equal(JSON.stringify(result).includes(capability), false);
  }
});

test('unmanaged native executors use only the graph lease and never leak host authority in result text', async () => {
  const f = fixture({ leaseExecutor: false, text: `Synthetic ${capability} ${ownToken} ${parentToken}` });
  const result = await f.attempt.run();
  assert.equal(f.calls.includes('executor-lease'), false);
  assert.equal(result.result.text, 'Synthetic [redacted] [redacted] [redacted]');
  assert.equal(JSON.stringify(result).includes(capability), false);
});

test('out-of-band close or revocation aborts the pending prompt and cleans the owned run and leases', async () => {
  for (const state of ['closed', 'revoked']) {
    const f = fixture();
    let polls = 0, cancellationObserved = false;
    const getRun = f.provider.getProjectAgentWorkerRun;
    f.provider.getProjectAgentWorkerRun = async (...args) => {
      polls++;
      assert.equal(args[2].capability, capability);
      return { ...await getRun(...args), state };
    };
    f.child.promptOnce = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      cancellationObserved = true;
      reject(signal.reason);
    }, { once: true }));
    const result = await createWorkerRunAttempt({ ...f.input, pollIntervalMs: 5 }).run();
    assert.equal(polls, 1);
    assert.equal(cancellationObserved, true);
    assert.deepEqual(result.outcome, { status: 'cancelled', code: 'worker_cancelled' });
    assert.deepEqual(result.cleanup, { processStopped: true, runClosed: true, errors: [] });
    assert.equal(f.activities.at(-1).worker_status, 'cancelled');
    assert.deepEqual(f.calls.filter(value => value.startsWith('release-')), ['release-executor', 'release-graph']);
  }
});

test('a timed-out authority read fails closed and a bounded attempt timeout also cleans up', async () => {
  for (const kind of ['poll', 'deadline']) {
    const f = fixture();
    f.provider.getProjectAgentWorkerRun = (_id, _scope, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    f.child.promptOnce = ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const result = await createWorkerRunAttempt({ ...f.input, pollIntervalMs: 5,
      pollTimeoutMs: 10, maxDurationMs: kind === 'deadline' ? 10 : 1000 }).run();
    assert.equal(result.outcome.code, kind === 'poll' ? 'worker_authority_unavailable' : 'worker_timeout');
    assert.equal(result.cleanup.processStopped, true);
    assert.equal(result.cleanup.runClosed, true);
  }
});

test('uncertain prompt results preserve one attempt and never blindly repeat side effects', async () => {
  for (const code of ['worker_connection_closed', 'worker_timeout', 'worker_cleanup_incomplete']) {
    const f = fixture();
    let prompts = 0, starts = 0;
    const start = f.adapter.start;
    f.adapter.start = async input => { starts++; return start(input); };
    f.child.promptOnce = async () => {
      prompts++;
      // A real adapter could have performed an action before losing its reply.
      throw Object.assign(new Error('Synthetic reply lost after a possible action'), { code });
    };
    const result = await createWorkerRunAttempt(f.input).run();
    assert.equal(starts, 1);
    assert.equal(prompts, 1);
    assert.equal(result.outcome.code, code);
    assert.equal(result.checkpoint, null);
    assert.equal(result.cleanup.runClosed, true);
    assert.equal(result.cleanup.processStopped, true);
    assert.equal(f.activities.at(-1).worker_status, 'failed');
  }
});

test('a fresh reporting host cannot relaunch an already claimed durable run', async () => {
  const f = fixture();
  let claimed = false, starts = 0;
  const claim = f.provider.claimProjectAgentWorkerStart;
  const start = f.adapter.start;
  f.provider.claimProjectAgentWorkerStart = async (...args) => {
    const response = await claim(...args);
    const start_claimed = !claimed;
    claimed = true;
    return { ...response, start_claimed };
  };
  f.adapter.start = async input => { starts++; return start(input); };
  const first = await createWorkerRunAttempt(f.input).run();
  const reports = f.activities.length;
  const closeCalls = f.calls.filter(value => value === 'close-run').length;
  // New object models a restarted host; the Provider still owns the same claim.
  const replay = await createWorkerRunAttempt(f.input).run();
  assert.equal(first.runId, replay.runId);
  assert.equal(starts, 1);
  assert.equal(replay.outcome.code, 'worker_start_not_claimed');
  assert.equal(f.activities.length, reports);
  assert.equal(f.calls.filter(value => value === 'close-run').length, closeCalls);
});

test('host persists a prompt claim and immutable cleanup evidence without completing the business task', async () => {
  const f = fixture();
  let dispatches = 0, saved;
  f.provider.dispatchProjectAgentWorkerPrompt = async () => { dispatches++; return { dispatch_claimed: true }; };
  f.provider.recordProjectAgentWorkerResult = async (_id, input) => {
    saved = structuredClone(input);
    assert.ok(f.calls.includes('close-process'));
    assert.ok(f.calls.includes('release-graph'));
    return { execution_result: { ...input, retry_eligible: false } };
  };
  const result = await createWorkerRunAttempt(f.input).run();
  assert.equal(dispatches, 1);
  assert.equal(saved.prompt_dispatched, true);
  assert.equal(saved.process_stopped, true);
  assert.equal(saved.run_closed, true);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.stage, 'checkpoint');
  assert.equal(f.activities.at(-1).status, 'awaiting_review');
  assert.equal(result.executionResult.retry_eligible, false);
});

test('lost dispatch acknowledgement is never repeated and lost terminal evidence blocks automatic retry', async () => {
  for (const phase of ['dispatch', 'result']) {
    const f = fixture();
    let prompts = 0;
    const prompt = f.child.promptOnce;
    f.child.promptOnce = async input => { prompts++; return prompt(input); };
    f.provider.dispatchProjectAgentWorkerPrompt = async () => {
      if (phase === 'dispatch') throw new Error('Synthetic lost dispatch response');
      return { dispatch_claimed: true };
    };
    f.provider.recordProjectAgentWorkerResult = async () => { throw new Error('Synthetic lost result response'); };
    const result = await createWorkerRunAttempt(f.input).run();
    assert.equal(prompts, phase === 'dispatch' ? 0 : 1);
    assert.equal(result.executionResult, null);
    assert.ok(result.cleanup.errors.includes('worker_result_record_failed'));
  }
});
