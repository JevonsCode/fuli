#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { PASS_TASK_TOKEN, TASK_RULES_ON_DEMAND } from '../lifecycle-message.js';
import { transcriptLifecycle } from '../../conversations/transcript-lifecycle.js';
import { transcriptCaptureScope } from '../../conversations/sync-transcript.js';
import { captureDecision, withCaptureLookups } from '../../graphiti/capture-decision.js';
import { compactTaskContext } from '../../conversations/task-context-view.js';
import { PREFERENCE_RESET_EVENTS, currentTaskPreferences, preferenceHookOutput, preferenceLifecycleOutput }
  from '../../conversations/preference-lifecycle.js';
import { inPlaceRefreshBasis } from './host-notification.js';
import { explicitlyContinuedInTurn, turnStart } from './turn-ownership.js';
import { skipTranscriptSpan, transcriptCaptureLedger, TURN_UNRESOLVED } from '../../conversations/transcript-capture-gap.js';
import { initialTranscriptBoundary, verifiedTranscriptEnd } from '../../conversations/transcript-reader.js';
import { transcriptDigest } from '../../conversations/transcript-guard.js';
import { normalizeClaudeRecord, verifyClaudeTranscript } from './conversation-transcript.js';
import { sessionFuliCommandResult, sessionFuliEntryRefusal, sessionFuliOffContext, sessionFuliSessionBegan }
  from '../../conversations/session-fuli-entry.js';

import { callAgentTool } from '../../agent-tools.js';
import { createRuntimeLeaseClient } from '../../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../../graphiti/runtime-config.js';
import { isMainModule } from '../../system/main-module.js';
import { readHookInput } from '../lifecycle-input.js';
import { stopHookOutcome } from '../../conversations/stop-auto-close.js';
import { outdatedMcpNotice, withOutdatedMcpNotice } from '../../mcp/process-registry.js';
import { FULI_VERSION } from '../../package-metadata.js';

export async function claudeLifecycleOutput(event, input, invoke, { delivery, currentTask, entryRefusal, onCurrentTask } = {}) {
  if (!['UserPromptSubmit', 'Stop', ...PREFERENCE_RESET_EVENTS].includes(event)) throw new TypeError('Unsupported Claude lifecycle event');
  const sessionId = input?.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) {
    throw new TypeError('Claude lifecycle requires a host session identifier');
  }
  const source = { sourceApplication: 'claude_code', sourceSessionId: sessionId };
  if (PREFERENCE_RESET_EVENTS.includes(event)) return preferenceLifecycleOutput(event, input,
    { sourceApplication: 'claude_code', delivery, currentTask, invoke });
  if (event === 'UserPromptSubmit') {
    if (typeof input.cwd !== 'string' || !input.cwd.trim() || typeof input.prompt !== 'string') {
      throw new TypeError('Claude task entry requires cwd and prompt');
    }
    // A session FULI is off for (rec#5 C3b) gets no task entry.
    const off = await entryRefusal?.();
    if (off) return { hookSpecificOutput: { hookEventName: event, additionalContext: sessionFuliOffContext(off) } };
    const basis = inPlaceRefreshBasis(input);
    if (basis) return claudeRefreshOutput(event, input, invoke, { delivery, currentTask, onCurrentTask }, basis);
    const context = await invoke('begin_task_context', {
      sessionId, projectPath: input.cwd, taskPrompt: input.prompt.slice(0, 8192), ...source
    });
    return preferenceHookOutput(compactTaskContext(context), event, input, delivery, 'claude_code',
      'Fuli task context. Read full context; apply effective_preferences. Follow checkpoint_guidance: checkpoint_task_knowledge only when there is something to record; the Stop hook closes the rest. ' + PASS_TASK_TOKEN + TASK_RULES_ON_DEMAND);
  }
  const check = await invoke('verify_task_checkpoint', { sessionId, ...source });
  return stopHookOutcome(check, invoke, source);
}

// A turn whose task transition cannot be proven re-reads the current task in
// place (rec#15): the same token, scope and Agent, with any preference,
// conflict or checkpoint change since. It never begins or switches a task, so
// an unfinished task keeps its checkpoint, and it never claims that this turn
// belongs to that task. Without a readable owned task it establishes none.
// The installed hook holds the turn as unresolved before any of this
// (runClaudeLifecycleHook); onCurrentTask names the task it was current for.
async function claudeRefreshOutput(event, input, invoke, { delivery, currentTask, onCurrentTask }, basis) {
  let refresh;
  const lookup = async (...parameters) => {
    const task = await currentTask?.(...parameters);
    if (task) await onCurrentTask?.(task);
    return task;
  };
  try {
    refresh = await currentTaskPreferences(input, { sourceApplication: 'claude_code', currentTask: lookup, invoke });
  } catch (error) {
    // Only the reader's own refusal text is shown; other failures stay private.
    refresh = { status: 'unreadable', reason: error?.code === 'preference_recovery_blocked' ? error.message : null };
  }
  return refresh.status === 'refreshed' ? preferenceHookOutput(refresh.context, event, input, delivery, 'claude_code',
    `${UNCONFIRMED_TURN[basis]} ${REFERENCE_ONLY} ${START_NEW_WORK} ${TASK_RULES_ON_DEMAND}`, true)
    : { hookSpecificOutput: { hookEventName: event, additionalContext: noValidContext(refresh) } };
}

function noValidContext(refresh) {
  const [zh, en] = NO_VALID_CONTEXT[refresh.status];
  return `FULI：本轮没有建立有效的任务上下文（${zh}），没有创建或切换任务。 FULI: no valid task context is established for this turn `
    + `(${en}${refresh.reason ? `: ${refresh.reason}` : ''}); no task was created or switched. ${START_NEW_WORK}`;
}

// A refresh turn whose unresolved state could not be kept anywhere does not
// reach the model: it would otherwise run unprotected.
const UNPROTECTED_TURN = 'FULI：无法保存本轮“任务归属未确认”的状态，为免把本轮记入或结算到当前任务，已拦下这条消息，请稍后重试。 '
  + 'FULI: could not keep this turn\'s task ownership as unresolved, so this message was held back rather than risk '
  + 'recording or settling it under the current task; retry shortly.';

// Bilingual: the person reads these in the transcript as well as the model.
const UNCONFIRMED_TURN = Object.freeze({
  envelope: 'FULI：本轮形如宿主通知，但来源和任务归属都未确认，没有创建或切换任务。 '
    + 'FULI: this turn looks like a host notification, but its source and task ownership are not confirmed; no task was created or switched.',
  system: 'FULI：本轮是宿主系统投递，但任务归属未确认，没有创建或切换任务。 '
    + 'FULI: this turn is a host system delivery, but its task ownership is not confirmed; no task was created or switched.'
});
const REFERENCE_ONLY = 'The current task context of this session follows for reference, refreshed now. Its taskContextToken '
  + 'is not this turn\'s confirmed task. This turn becomes that task\'s only by a successful checkpoint_task_knowledge with '
  + 'that token in this turn, which you should make only if you know this turn continues that task\'s own work.';
const START_NEW_WORK = 'If this turn is new work, start a task explicitly with get_collaboration_preferences '
  + '(projectPath = current working directory, taskPrompt = the request) and use the taskContextToken it returns.';
const NO_VALID_CONTEXT = Object.freeze({
  no_task: ['本会话没有当前任务', 'this session has no current task'],
  task_closed: ['本会话的当前任务已关闭', 'the current task of this session is closed'],
  other_session: ['当前任务属于其他会话', 'the current task belongs to another session'],
  fuli_off: ['本会话已停用 FULI', 'FULI is off for this session'],
  unreadable: ['当前任务的归属或范围无法确认', 'the current task\'s ownership or scope could not be confirmed']
});

export function claudeLifecycleUnavailable(event, input = null, reason = null) {
  const warning = reason ?? 'Fuli context is unavailable; memory recovery and task checkpoint are not verified. '
    + 'Continue with the user request and use Fuli MCP when it becomes available.';
  const sessionId = input?.session_id;
  const fallback = event === 'UserPromptSubmit' && inPlaceRefreshBasis(input) ? ` ${START_NEW_WORK}`
    : typeof sessionId === 'string' && sessionId.trim() && sessionId.length <= 256
    ? ` No valid Hook task context was supplied. First call get_collaboration_preferences with sessionId=${JSON.stringify(sessionId)}, projectPath=current working directory and taskPrompt=current user request. Follow checkpoint_required and checkpoint_guidance; use its fresh taskContextToken for checkpoint_task_knowledge with a truthful workLog when there is something to record. Native transcript capture remains unverified; do not reuse an old token or claim this Hook delivered task context.`
    : '';
  return event === 'UserPromptSubmit'
    ? { systemMessage: warning, hookSpecificOutput: { hookEventName: event, additionalContext: warning + fallback } }
    : { systemMessage: warning };
}

export async function runClaudeLifecycleHook(args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  const input = await (dependencies.readInput ?? readHookInput)();
  if (dependencies.invoke) return claudeLifecycleOutput(event, input, dependencies.invoke);
  const { runtimeConfigPath } = (dependencies.resolveRuntimeOptions ?? resolveGraphRuntimeOptions)(
    args, dependencies.env ?? process.env
  );
  const ledger = runtimeConfigPath && typeof input?.session_id === 'string' && input.session_id.trim()
    ? transcriptCaptureLedger(runtimeConfigPath, input, 'claude_code') : null;
  // A turn whose ownership cannot be proven is held as unresolved before
  // anything else can fail or return: whatever the read below finds, its
  // Stop neither settles the session's task nor records the turn under it.
  const refreshTurn = event === 'UserPromptSubmit' && inPlaceRefreshBasis(input) ? randomUUID() : null;
  if (refreshTurn && !ledger?.holdTurn({ turn: refreshTurn, from: turnStart(input.transcript_path) })) {
    return { decision: 'block', reason: UNPROTECTED_TURN };
  }
  let app;
  let leases;
  try {
    app = (dependencies.openApplication ?? openFederatedGraphApplication)({ runtimeConfigPath });
    leases = (dependencies.createLeases ?? createRuntimeLeaseClient)({ runtimeConfigPath });
    const request = { signal: dependencies.signal };
    const output = await leases.withGraphLease('claude-code-lifecycle', () => withCaptureLookups(async () => {
      // The person's /fuli line is answered here and never reaches the model.
      const command = event === 'UserPromptSubmit' ? await sessionFuliCommandResult(app, { sessionId: input.session_id,
        sourceApplication: 'claude_code', prompt: input.prompt, projectPath: input.cwd }) : null;
      if (claudeSessionBegins(event, input)) sessionFuliSessionBegan(app, { sessionId: input.session_id, sourceApplication: 'claude_code' });
      if (command) return claudeSessionCommandOutput(command);
      const call = (name, parameters) => (dependencies.callTool ?? callAgentTool)(app, name, parameters, request);
      const currentTask = app.taskContextRegistry?.current?.bind(app.taskContextRegistry);
      const entryRefusal = () => sessionFuliEntryRefusal(app, { sessionId: input.session_id, sourceApplication: 'claude_code' });
      // A refresh begins no task and claims no transcript boundary. Its turn
      // stays held through a session reset, compaction or FULI going off, until
      // an explicit resolution in a later Stop's turn or a fresh task entry.
      if (refreshTurn) return claudeLifecycleOutput(event, input, call, { delivery: app.preferenceDelivery, currentTask,
        entryRefusal, onCurrentTask: task => ledger.ownTurn(refreshTurn, transcriptDigest(task.token)) });
      if (PREFERENCE_RESET_EVENTS.includes(event)) return claudeLifecycleOutput(event, input, call,
        { delivery: app.preferenceDelivery, currentTask });
      const unresolved = event === 'Stop' && await settleHeldTurns(app, ledger, input, currentTask) === 'held';
      // Turns held before this prompt end once it freshly enters a task; the
      // entry's sync skips what is left of them, and nothing before the prompt
      // may be imported later either.
      const held = event === 'UserPromptSubmit' ? ledger?.heldTurns() : null;
      let entered = false;
      if (input.transcript_path && (await captureDecision(app, transcriptCaptureScope(input, 'claude_code'))).allowed) {
        dependencies.onTranscriptGuard?.();
      }
      const lifecycle = await transcriptLifecycle({ application: app, runtimeConfigPath, input, event, sourceApplication: 'claude_code',
        captureTimeoutMs: dependencies.captureTimeoutMs, signal: dependencies.signal,
        adapter: CLAUDE_TRANSCRIPT,
        // An unresolved turn's Stop neither verifies nor closes the task; its sync skips the turn.
        run: onContext => unresolved ? Promise.resolve({}) : claudeLifecycleOutput(event, input, async (name, parameters) => {
          const context = await call(name, parameters);
          if (name === 'begin_task_context') { entered = true; onContext(context); }
          return context;
        }, { delivery: app.preferenceDelivery, entryRefusal }) });
      if (entered && (held?.unprovable || held?.turns.length)) {
        const before = await initialTranscriptBoundary(input.transcript_path, input.session_id, input.prompt,
          CLAUDE_TRANSCRIPT).catch(() => null);
        if (before !== null) ledger.enteredAfter(before);
      }
      return lifecycle;
    }), request);
    return event === 'UserPromptSubmit' ? withOutdatedMcpNotice(output, outdatedMcpNotice(runtimeConfigPath,
      { sourceApplication: 'claude_code', version: FULI_VERSION, sessionId: input.session_id })) : output;
  } finally {
    await Promise.allSettled([close(leases), close(app)]);
  }
}

const CLAUDE_TRANSCRIPT = Object.freeze({ normalize: normalizeClaudeRecord, verify: verifyClaudeTranscript });

// What this Stop may do about the session's held turns: 'held' settles and
// records nothing, 'normal' lets it run. Held turns end only by evidence from
// the last of them: a successful explicit continuation of the task it was
// current for, which the Provider confirms (that turn is then imported under
// the task, everything before it only as a skipped span), or another task,
// or none, being current (all of it is skipped). A state that cannot be
// proven, an unknown owner or a failed lookup or skip keeps them held.
async function settleHeldTurns(application, ledger, input, currentTask) {
  const held = ledger?.heldTurns();
  if (!held) return 'normal';
  if (held.unprovable) return 'held';
  const skipUntil = end => skipTranscriptSpan(application, input, 'claude_code', TURN_UNRESOLVED, end);
  if (!held.turns.length) {
    if (held.skipUntil === null) return 'normal';
    if ((await skipUntil(async () => held.skipUntil)).status === 'failed') return 'held';
    ledger.skipped(held.skipUntil);
    return 'normal';
  }
  const latest = held.turns.at(-1);
  let task;
  try { task = await currentTask?.(input.session_id, 'claude_code'); } catch { return 'held'; }
  if (task === undefined) return 'held';
  const moved = !task || (latest.owner !== null && transcriptDigest(task.token) !== latest.owner);
  const proven = !moved && latest.owner !== null && task.checkpoint?.phase === 'complete'
    && explicitlyContinuedInTurn(input.transcript_path, input.session_id, task.token, latest.from);
  if (!moved && !proven) return 'held';
  const end = moved ? () => verifiedTranscriptEnd(input.transcript_path, input.session_id, CLAUDE_TRANSCRIPT)
    : async () => latest.from;
  if ((await skipUntil(end)).status === 'failed') return 'held';
  return ledger.endTurns(latest.turn) ? 'normal' : 'held';
}

// Only SessionStart with source "startup" is documented as a new session
// (code.claude.com/docs/en/hooks, SessionStart matchers); resume, clear,
// compact and fork are not taken as proof that the session begins now.
function claudeSessionBegins(event, input) {
  return event === 'SessionStart' && input?.source === 'startup' && typeof input.session_id === 'string';
}

// Claude Code shows a blocked prompt's reason to the person and sends nothing to the model.
function claudeSessionCommandOutput(result) {
  return { decision: 'block', reason: `FULI: ${result.message}` };
}

async function close(resource) { await resource?.close(); }


async function main() {
  const args = process.argv.slice(2);
  const event = args[args.indexOf('--event') + 1];
  const configured = args.includes('--timeout-ms') ? Number(args[args.indexOf('--timeout-ms') + 1]) : 28000;
  const timeoutMs = Number.isSafeInteger(configured) && configured > 0 && configured <= 2_147_483_647
    ? configured : 28000;
  const controller = new AbortController();
  let input = null;
  let emitted = false;
  const emit = (output, callback) => {
    if (emitted) return;
    emitted = true;
    process.stdout.write(`${JSON.stringify(output)}\n`, callback);
  };
  // Finish before the host timeout, even if a dependency ignores cancellation.
  // No prompt, transcript, path or raw exception is written to diagnostics.
  const deadline = setTimeout(() => {
    controller.abort();
    emit(claudeLifecycleUnavailable(event, input), () => process.exit(0));
  }, timeoutMs);
  const abort = setTimeout(() => controller.abort(), Math.max(1, timeoutMs - 1500));
  try {
    const output = await runClaudeLifecycleHook(args, { signal: controller.signal,
      captureTimeoutMs: Math.max(1, Math.min(750, Math.floor(timeoutMs / 4))),
      readInput: async () => { input = await readHookInput(); return input; } });
    emit(output);
  } catch {
    emit(claudeLifecycleUnavailable(event, input));
  } finally {
    clearTimeout(abort);
    clearTimeout(deadline);
  }
}

if (isMainModule(import.meta.url)) await main();
