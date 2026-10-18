import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApplicationError } from '../app/application-error.js';
import { validateWorkerDescriptor } from './worker-descriptor.js';

const failure = code => new ApplicationError(`worker_${code}`, `Worker ${code.replaceAll('_', ' ')}.`);
const bounded = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const taskToken = value => typeof value === 'string' && /^fuli-task-[a-zA-Z0-9-]{8,128}$/.test(value);
const knownFailures = new Set(['worker_authentication_required', 'worker_authentication_unknown', 'worker_workspace_untrusted', 'worker_model_unavailable',
  'worker_model_mismatch', 'worker_cancelled', 'worker_timeout', 'worker_connection_closed', 'worker_cleanup_incomplete',
  'worker_identity_mismatch', 'worker_model_strategy_unmapped', 'worker_result_mismatch', 'worker_authority_unavailable',
  'worker_runtime_offline', 'worker_runtime_recovery']);

// A trusted host creates one attempt, never a model-facing tool or a scheduler.
// Retain the same capability and idempotency key when recovering a lost prepare;
// a false/uncertain start claim never authorizes another process.
export function createWorkerRunAttempt({ provider, leases, adapter, request, projectPath, taskPrompt, toolNames,
  leaseExecutor = false, capability = randomBytes(32).toString('hex'),
  pollIntervalMs = 1000, pollTimeoutMs = 5000, maxDurationMs = 30 * 60_000 }) {
  for (const value of [pollIntervalMs, pollTimeoutMs, maxDurationMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60_000) throw failure('invalid_attempt');
  }
  const selection = structuredClone(request);
  const descriptor = validateWorkerDescriptor({ runId: 'pending', personalProjectId: selection.personal_project_id,
    capability, projectPath, taskPrompt, toolNames });
  if (!taskToken(selection.task_context_token) || !bounded(selection.idempotency_key, 256) ||
      selection.target_application !== adapter.application || typeof adapter.start !== 'function' ||
      typeof leaseExecutor !== 'boolean' || !descriptor.toolNames.includes('checkpoint_task_knowledge') ||
      !descriptor.toolNames.some(name => ['begin_task_context', 'get_collaboration_preferences'].includes(name))) {
    throw failure('invalid_attempt');
  }
  let pending;
  return { run({ signal } = {}) { return pending ??= execute(signal); } };

  async function execute(callerSignal) {
    const authority = new AbortController(), watching = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, authority.signal]) : authority.signal;
    const deadline = setTimeout(() => authority.abort(failure('timeout')), maxDurationMs);
    let monitor;
    const scope = { personal_space_id: selection.personal_space_id, personal_project_id: selection.personal_project_id };
    const handles = [], cleanupErrors = [];
    let runId, claimed = false, sealed = false, child, parent, sessionId, ownToken, checkpoint, result;
    let stage = 'lease', runningRecorded = false, terminalRecorded = false;
    let processStopped = false, runClosed = false, promptDispatched = false, executionResult = null;
    let outcome = { status: 'blocked', code: 'worker_not_started' };
    const checkCancelled = () => { if (signal?.aborted) throw failure('cancelled'); };
    const redact = value => [capability, selection.task_context_token, ownToken].filter(Boolean)
      .reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
    const runtime = () => ({ application: adapter.application, ...(sessionId ? { session_id: sessionId } : {}) });
    const checkRun = (run, states, expectedSession) => {
      if (!bounded(run?.run_id, 128) || (runId && run.run_id !== runId) || !states.includes(run.state) ||
          ['personal_space_id', 'personal_project_id', 'task_id', 'agent_id', 'worker_id', 'executor_id',
            'target_application'].some(key => run[key] !== selection[key]) ||
          run.requested_model_provider !== selection.provider || run.requested_model !== selection.model ||
          !sameStrategy(run.requested_model_strategy, selection.model_strategy) ||
          (expectedSession && run.actual_session_id !== expectedSession)) throw failure('identity_mismatch');
      return run;
    };
    const checkContext = (context, token) => {
      if (context?.token !== token || context.token === selection.task_context_token ||
          context.personal_space_id !== scope.personal_space_id || context.personal_project_id !== scope.personal_project_id ||
          context.project_agent_id !== selection.agent_id || context.source_application !== adapter.application ||
          context.session_id !== sessionId || context.source_session_id !== sessionId ||
          context.turn_id !== `worker-run:${runId}`) throw failure('identity_mismatch');
      return context;
    };
    const admit = async () => {
      const admitted = checkRun(await provider.admitProjectAgentWorkerContext(runId,
        { ...scope, source_application: adapter.application, session_id: sessionId }, { capability, signal }),
      ['admitted'], sessionId);
      const token = admitted.own_context_token;
      if (!taskToken(token) || (ownToken && token !== ownToken)) throw failure('identity_mismatch');
      checkContext(admitted.task_context, token);
      ownToken = token;
    };
    const readCheckpoint = async requestSignal => {
      const context = checkContext(await provider.getTaskContext(ownToken,
        { personal_space_id: scope.personal_space_id, source_application: adapter.application }, { signal: requestSignal }), ownToken);
      const value = context.checkpoint;
      if (!value || value.phase !== 'complete') return null;
      const log = value.work_log;
      if (!['completed', 'no_change', 'incomplete', 'failed', 'reported', 'unreported'].includes(log?.status) ||
          !bounded(log.summary, 2000)) throw failure('result_mismatch');
      return { phase: 'complete', workLog: { status: log.status, summary: redact(log.summary) } };
    };
    const report = (workerStatus, summary, phase) => provider.recordProjectAgentTaskActivity({ ...scope,
      task_id: selection.task_id, agent_id: selection.agent_id, worker_id: selection.worker_id,
      status: workerStatus === 'completed' ? 'awaiting_review' : 'running', worker_status: workerStatus, worker_runtime: runtime(),
      source_application: parent.source_application, source_session_id: parent.session_id,
      idempotency_key: `${runId}:${phase}`, summary,
      // No transcript lookup in the reporting host's daily client home.
      token_usage: null
    }, { signal: null });
    try {
      checkCancelled();
      handles.push(await leases.acquireGraphLease(`worker:${selection.worker_id}`));
      checkCancelled();
      if (leaseExecutor) handles.push(await leases.acquireExecutorLease(selection.executor_id, `worker:${selection.worker_id}`));
      checkCancelled();
      stage = 'parent';
      parent = await provider.getTaskContext(selection.task_context_token,
        { personal_space_id: scope.personal_space_id, source_application: selection.source_application }, { signal });
      if (parent?.token !== selection.task_context_token || parent.personal_space_id !== scope.personal_space_id ||
          parent.personal_project_id !== scope.personal_project_id || parent.source_application !== selection.source_application ||
          !bounded(parent.session_id, 256)) throw failure('identity_mismatch');
      checkCancelled();
      stage = 'prepare';
      const prepared = checkRun(await provider.prepareProjectAgentWorkerRun({ ...selection,
        runtime_capability_hash: createHash('sha256').update(capability).digest('hex') }, { signal }),
      ['prepared', 'claimed', 'sealed', 'admitted', 'closed', 'revoked']);
      runId = prepared.run_id;
      stage = 'claim';
      checkCancelled();
      const claim = checkRun(await provider.claimProjectAgentWorkerStart(runId, scope, { capability, signal }),
        ['claimed', 'sealed', 'admitted', 'closed', 'revoked']);
      if (claim.start_claimed !== true) {
        outcome = { status: 'not_started', code: 'worker_start_not_claimed' };
      } else {
        if (claim.state !== 'claimed') throw failure('identity_mismatch');
        claimed = true;
        monitor = watchRun();
        stage = 'start';
        checkCancelled();
        child = await adapter.start({ descriptor: { ...descriptor, runId }, selection: {
          target_application: selection.target_application, provider: selection.provider, model: selection.model,
          model_strategy: structuredClone(selection.model_strategy)
        }, signal });
        stage = 'session';
        checkCancelled();
        const session = await child.newSession();
        if (!bounded(session?.sessionId, 128) || session.sessionId === parent.session_id) throw failure('identity_mismatch');
        sessionId = session.sessionId;
        stage = 'seal';
        checkCancelled();
        checkRun(await provider.sealProjectAgentWorkerSession(runId,
          { ...scope, source_application: adapter.application, session_id: sessionId }, { capability, signal }), ['sealed'], sessionId);
        sealed = true;
        stage = 'admit';
        await admit();
        stage = 'configure';
        checkCancelled();
        await child.configure();
        // Configuration can take time; recheck authority immediately before dispatch.
        stage = 'admit';
        await admit();
        stage = 'running_activity';
        checkCancelled();
        await report('running', 'Worker session admitted; one prompt attempt is starting. Actual model use is unverified.', 'running');
        runningRecorded = true;
        stage = 'dispatch';
        checkCancelled();
        // Set the uncertainty flag before the call: a lost ACK may have committed.
        promptDispatched = true;
        const dispatched = await provider.dispatchProjectAgentWorkerPrompt(runId, scope, { capability, signal });
        if (dispatched.dispatch_claimed !== true) throw failure('dispatch_not_claimed');
        stage = 'prompt';
        checkCancelled();
        const reply = await child.promptOnce({ text: workerPrompt(taskPrompt), signal });
        if (reply?.sessionId !== sessionId || typeof reply.text !== 'string' || Buffer.byteLength(reply.text) > 64 * 1024 ||
            !bounded(reply.stopReason, 128)) {
          throw failure('result_mismatch');
        }
        result = { text: redact(reply.text), stopReason: redact(reply.stopReason) };
        stage = 'checkpoint';
        checkCancelled();
        checkpoint = await readCheckpoint(signal);
        checkCancelled();
        outcome = checkpointOutcome(result.stopReason, checkpoint);
      }
    } catch (error) {
      const code = callerSignal?.aborted ? 'worker_cancelled'
        : authority.signal.aborted ? authority.signal.reason.code
        : error?.code === 'worker_cancelled' ? 'worker_cancelled'
        : knownFailures.has(error?.code) ? error.code : `worker_${stage}_failed`;
      outcome = { status: code.endsWith('_cancelled') ? 'cancelled'
        : ['worker_authentication_required', 'worker_authentication_unknown', 'worker_workspace_untrusted', 'worker_model_unavailable',
          'worker_model_strategy_unmapped'].includes(code) ? 'blocked'
          : stage === 'checkpoint' && !['worker_identity_mismatch', 'worker_result_mismatch'].includes(code)
            ? 'incomplete' : 'failed', code };
      if (error?.cleanupIncomplete || code === 'worker_cleanup_incomplete') cleanupErrors.push('worker_process_cleanup_incomplete');
      if (ownToken) {
        try { checkpoint = await readCheckpoint(null); } catch { /* Preserve the terminal cause. */ }
      }
    } finally {
      clearTimeout(deadline);
      watching.abort();
      await monitor;
      // Close authority before stopping the owned process. Never close a run whose
      // start claim belonged to another host, even if prepare was an idempotent retry.
      if (claimed) {
        try {
          checkRun(await provider.closeProjectAgentWorkerRun(runId, { ...scope, reason: outcome.code },
            { capability, signal: null }), ['closed', 'revoked'], sealed ? sessionId : undefined);
          runClosed = true;
        } catch { cleanupErrors.push('worker_run_close_failed'); }
      }
      if (child) {
        try { await child.close(); processStopped = true; }
        catch { cleanupErrors.push('worker_process_cleanup_incomplete'); }
        if (cleanupErrors.length) outcome = { status: 'failed', code: 'worker_cleanup_incomplete' };
        try {
          const workerStatus = { completed: 'completed', incomplete: 'awaiting_review', blocked: 'blocked',
            cancelled: 'cancelled', failed: 'failed' }[outcome.status];
          await report(workerStatus, `${outcome.code}. Actual model use is unverified.` +
            (checkpoint ? ` Child work log: ${checkpoint.workLog.summary}` : ''), 'terminal');
          terminalRecorded = true;
        } catch { cleanupErrors.push('worker_terminal_activity_failed'); }
      }
      for (const handle of handles.reverse()) {
        try {
          const released = await leases.releaseLease(handle);
          if (handle.enabled && released?.released !== true) cleanupErrors.push('worker_lease_release_failed');
        } catch { cleanupErrors.push('worker_lease_release_failed'); }
      }
    }
    if (outcome.status === 'completed' && cleanupErrors.length) {
      // The saved child checkpoint remains evidence of its work, but the host
      // has not delivered a successful attempt until reporting and cleanup finish.
      outcome = { status: 'incomplete', code: 'worker_host_finalization_incomplete' };
    }
    if (claimed) {
      try {
        const saved = await provider.recordProjectAgentWorkerResult(runId, { ...scope,
          status: outcome.status, code: outcome.code, stage, prompt_dispatched: promptDispatched,
          process_stopped: processStopped, run_closed: runClosed, terminal_recorded: terminalRecorded,
          cleanup_errors: [...cleanupErrors] }, { capability, signal: null });
        executionResult = saved.execution_result ?? null;
      } catch {
        cleanupErrors.push('worker_result_record_failed');
        if (outcome.status === 'completed') outcome = { status: 'incomplete', code: 'worker_host_finalization_incomplete' };
      }
    }
    return { runId: runId ?? null, outcome, ...(child ? { workerRuntime: runtime() } : {}),
      executionResult,
      result: result ?? null, checkpoint: checkpoint ?? null,
      reporting: { runningRecorded, terminalRecorded }, cleanup: { processStopped, runClosed, errors: cleanupErrors } };

    async function watchRun() {
      try {
        while (!watching.signal.aborted && !signal.aborted) {
          await delay(pollIntervalMs, undefined, { signal: watching.signal });
          const run = checkRun(await provider.getProjectAgentWorkerRun(runId, scope, { capability,
            signal: AbortSignal.any([signal, watching.signal, AbortSignal.timeout(pollTimeoutMs)]) }),
          ['claimed', 'sealed', 'admitted', 'closed', 'revoked']);
          if (['closed', 'revoked'].includes(run.state)) {
            authority.abort(failure('cancelled'));
            return;
          }
        }
      } catch {
        if (!watching.signal.aborted && !signal.aborted) authority.abort(failure('authority_unavailable'));
      }
    }
  }
}

function sameStrategy(a, b) {
  return a && b && a.mode === b.mode && a.reasoning_effort === b.reasoning_effort &&
    JSON.stringify(a.capability_hints ?? []) === JSON.stringify(b.capability_hints ?? []);
}
function workerPrompt(taskPrompt) {
  return 'You are an already assigned worker for one bounded attempt. First call begin_task_context or ' +
    'get_collaboration_preferences and apply its isolated context. Do not delegate or use a parent task token. ' +
    'Before finishing, call checkpoint_task_knowledge with your own returned taskContextToken and a truthful ' +
    'workLog (summary and status). Return your result and evidence to the coordinator; the coordinator owns ' +
    'acceptance and final task completion.\n\nAssigned task:\n' + taskPrompt;
}
function checkpointOutcome(stopReason, checkpoint) {
  if (stopReason === 'cancelled') return { status: 'cancelled', code: 'worker_cancelled' };
  if (stopReason !== 'end_turn') return { status: 'incomplete', code: 'worker_prompt_incomplete' };
  if (!checkpoint) return { status: 'incomplete', code: 'worker_checkpoint_missing' };
  const status = checkpoint.workLog.status;
  return ['completed', 'no_change'].includes(status) ? { status: 'completed', code: 'worker_checkpoint_completed' }
    : status === 'failed' ? { status: 'failed', code: 'worker_checkpoint_failed' }
      : { status: 'incomplete', code: 'worker_checkpoint_incomplete' };
}
