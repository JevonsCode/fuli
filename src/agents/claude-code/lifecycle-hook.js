#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { PASS_TASK_TOKEN, TASK_RULES_ON_DEMAND, taskClosingInstruction } from '../lifecycle-message.js';
import { transcriptLifecycle } from '../../conversations/transcript-lifecycle.js';
import { transcriptCaptureScope } from '../../conversations/sync-transcript.js';
import { captureDecision, withCaptureLookups } from '../../graphiti/capture-decision.js';
import { compactTaskContext } from '../../conversations/task-context-view.js';
import { PREFERENCE_RESET_EVENTS, preferenceHookOutput, preferenceLifecycleOutput }
  from '../../conversations/preference-lifecycle.js';
import { inPlaceRefreshBasis } from './host-notification.js';
import { explicitlyContinuedInTurn } from './turn-ownership.js';
import { endTurnsObservedAtEntry, refreshCurrentTaskInPlace, settleHeldTurns, START_NEW_WORK, turnStart,
  unprotectedTurnReason } from '../../conversations/unresolved-turns.js';
import { transcriptCaptureLedger } from '../../conversations/transcript-capture-gap.js';
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
import { taskSceneInput } from '../../graphiti/task-scene.js';
import { entryBudget, entryNotice, noteEntryNotice, NO_TASK_AT_DEADLINE, partialEntryText, runWithEntryBudget } from '../../conversations/entry-budget.js';

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
      sessionId, projectPath: input.cwd, taskPrompt: input.prompt.slice(0, 8192), ...source, ...taskSceneInput(input.prompt)
    });
    const entry = compactTaskContext(context);
    return preferenceHookOutput(entry, event, input, delivery, 'claude_code',
      'Fuli task context. Apply effective_preferences. ' + taskClosingInstruction(entry) + PASS_TASK_TOKEN + TASK_RULES_ON_DEMAND);
  }
  const check = await invoke('verify_task_checkpoint', { sessionId, ...source });
  return stopHookOutcome(check, invoke, source);
}

// A turn whose task transition cannot be proven re-reads the current task in
// place (rec#15, unresolved-turns.js). The installed hook holds the turn as
// unresolved before any of this (runClaudeLifecycleHook); onCurrentTask names
// the task it was current for.
function claudeRefreshOutput(event, input, invoke, { delivery, currentTask, onCurrentTask }, basis) {
  return refreshCurrentTaskInPlace(event, input, invoke, { ...CLAUDE_UNRESOLVED_TURNS, unconfirmed: UNCONFIRMED_TURN[basis] },
    { delivery, currentTask, onCurrentTask });
}

const UNPROTECTED_TURN = unprotectedTurnReason({ zh: '它像宿主通知', en: 'it looks like a host notification' });

// Bilingual: the person reads these in the transcript as well as the model.
const UNCONFIRMED_TURN = Object.freeze({
  envelope: 'FULI：本轮形如宿主通知，但来源和任务归属都未确认，没有创建或切换任务。 '
    + 'FULI: this turn looks like a host notification, but its source and task ownership are not confirmed; no task was created or switched.',
  system: 'FULI：本轮是宿主系统投递，但任务归属未确认，没有创建或切换任务。 '
    + 'FULI: this turn is a host system delivery, but its task ownership is not confirmed; no task was created or switched.'
});

export function claudeLifecycleUnavailable(event, input = null, reason = null, incomplete = '') {
  const warning = reason ?? 'Fuli context is unavailable; memory recovery and task checkpoint are not verified. '
    + 'Continue with the user request and use Fuli MCP when it becomes available.';
  const sessionId = input?.session_id;
  const fallback = event === 'UserPromptSubmit' && inPlaceRefreshBasis(input) ? ` ${START_NEW_WORK}`
    : typeof sessionId === 'string' && sessionId.trim() && sessionId.length <= 256
    ? ` No valid Hook task context was supplied. First call get_collaboration_preferences with sessionId=${JSON.stringify(sessionId)}, projectPath=current working directory and taskPrompt=current user request. Follow checkpoint_required and checkpoint_guidance; use its fresh taskContextToken for checkpoint_task_knowledge with a truthful workLog when there is something to record. Native transcript capture remains unverified; do not reuse an old token or claim this Hook delivered task context.${incomplete}`
    : '';
  return event === 'UserPromptSubmit'
    ? { systemMessage: warning, hookSpecificOutput: { hookEventName: event, additionalContext: warning + fallback } }
    : { systemMessage: warning };
}

// At the deadline an entry that already wrote its task delivers its token and
// what is missing (entry-budget.js); otherwise the fallback says what to fetch.
export function claudeEntryDeadlineOutput(event, input, budget) {
  const partial = event === 'UserPromptSubmit' ? partialEntryText(budget) : null;
  const output = partial ? { systemMessage: 'Fuli task context is partial: the hook deadline came before it was complete.',
    hookSpecificOutput: { hookEventName: event, additionalContext: partial } }
    : claudeLifecycleUnavailable(event, input, null, NO_TASK_AT_DEADLINE);
  return event === 'UserPromptSubmit' ? withOutdatedMcpNotice(output, entryNotice(budget)) : output;
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
  // Noted before the entry runs, so an answer at the deadline carries it too.
  const notice = noteEntryNotice(() => outdatedMcpNotice(runtimeConfigPath,
    { sourceApplication: 'claude_code', version: FULI_VERSION, sessionId: input?.session_id }));
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
      const unresolved = event === 'Stop'
        && await settleHeldTurns(app, ledger, input, currentTask, CLAUDE_UNRESOLVED_TURNS) === 'held';
      // Turns held when this prompt starts end once it freshly enters a task:
      // only those (a turn held while the entry runs stays held). The entry's
      // sync skips what is left of them, and nothing before the prompt may be
      // imported later either.
      const held = event === 'UserPromptSubmit' ? ledger?.entrySnapshot() : null;
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
      if (entered) await endTurnsObservedAtEntry(ledger, held, input, CLAUDE_UNRESOLVED_TURNS);
      return lifecycle;
    }), request);
    return event === 'UserPromptSubmit' ? withOutdatedMcpNotice(output, notice()) : output;
  } finally {
    await Promise.allSettled([close(leases), close(app)]);
  }
}

const CLAUDE_TRANSCRIPT = Object.freeze({ normalize: normalizeClaudeRecord, verify: verifyClaudeTranscript });

// Claude Code's policy for unresolved turns (unresolved-turns.js): a
// successful checkpoint_task_knowledge with the task's token in the turn,
// recorded by the host, proves the turn that task's (turn-ownership.js), and
// the model is told exactly that.
const CLAUDE_UNRESOLVED_TURNS = Object.freeze({
  sourceApplication: 'claude_code', adapter: CLAUDE_TRANSCRIPT,
  resolution: 'The current task context of this session follows for reference, refreshed now. Its taskContextToken '
    + 'is not this turn\'s confirmed task. This turn becomes that task\'s only by a successful checkpoint_task_knowledge with '
    + 'that token in this turn, which you should make only if you know this turn continues that task\'s own work.',
  continuedInTurn: (input, token, from) => explicitlyContinuedInTurn(input.transcript_path, input.session_id, token, from)
});

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
  // The entry's own time ends where its requests are cancelled.
  const abortAfterMs = Math.max(1, timeoutMs - 1500);
  const budget = entryBudget(abortAfterMs);
  const deadline = setTimeout(() => {
    controller.abort();
    emit(claudeEntryDeadlineOutput(event, input, budget), () => process.exit(0));
  }, timeoutMs);
  const abort = setTimeout(() => controller.abort(), abortAfterMs);
  try {
    const output = await runWithEntryBudget(budget, () => runClaudeLifecycleHook(args, { signal: controller.signal,
      captureTimeoutMs: Math.max(1, Math.min(750, Math.floor(timeoutMs / 4))),
      readInput: async () => { input = await readHookInput(); return input; } }));
    emit(output);
  } catch {
    emit(controller.signal.aborted ? claudeEntryDeadlineOutput(event, input, budget) : claudeLifecycleUnavailable(event, input));
  } finally {
    clearTimeout(abort);
    clearTimeout(deadline);
  }
}

if (isMainModule(import.meta.url)) await main();
