import { randomUUID } from 'node:crypto';
import { hookFailureCause, PASS_TASK_TOKEN, TASK_RULES_ON_DEMAND, taskClosingInstruction } from '../lifecycle-message.js';
import { transcriptLifecycle } from '../../conversations/transcript-lifecycle.js';
import { transcriptCaptureScope } from '../../conversations/sync-transcript.js';
import { captureDecision, withCaptureLookups } from '../../graphiti/capture-decision.js';
import { compactTaskContext } from '../../conversations/task-context-view.js';
import { PREFERENCE_RESET_EVENTS, preferenceHookOutput, preferenceLifecycleOutput }
  from '../../conversations/preference-lifecycle.js';
import { claudeTurnOrigin } from './host-notification.js';
import { explicitlyContinuedInTurn } from './turn-ownership.js';
import { endTurnsObservedAtEntry, quietHostTurn, settleHeldTurns, turnStart,
  unprotectedTurnReason } from '../../conversations/unresolved-turns.js';
import { transcriptCaptureLedger } from '../../conversations/transcript-capture-gap.js';
import { transcriptDigest } from '../../conversations/transcript-guard.js';
import { normalizeClaudeRecord, verifyClaudeTranscript } from './conversation-transcript.js';
import { recordClaudeSessionClient } from './session-client.js';
import { sessionFuliCommandResult, sessionFuliEntryRefusal, sessionFuliOffContext, sessionFuliSessionBegan }
  from '../../conversations/session-fuli-entry.js';

import { callAgentTool } from '../../agent-tools.js';
import { createRuntimeLeaseClient } from '../../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../../graphiti/runtime-config.js';
import { testToolsEnabled } from '../../app/test-tools.js';
import { consoleRecoveryNotice, recordHookFailure, runtimeConfigPathOf } from '../lifecycle-failure.js';
import { parseHookInput, readHookInput } from '../lifecycle-input.js';
import { stopHookOutcome } from '../../conversations/stop-auto-close.js';
import { claudeTurnRecords } from './turn-records.js';
import { claudeSessionModel } from './session-model.js';
import { outdatedMcpNotice, withOutdatedMcpNotice } from '../../mcp/process-registry.js';
import { FULI_VERSION } from '../../package-metadata.js';
import { taskSceneInput } from '../../graphiti/task-scene.js';
import { entryBudget, entryNotice, noteEntryNotice, NO_TASK_AT_DEADLINE, partialEntryText, runWithEntryBudget } from '../../conversations/entry-budget.js';
import { recordDebugTurn } from '../../debug-turns/recorder.js';
import { withDebugMarkNotice, withoutDebugMark } from '../../debug-turns/trigger.js';
import { claudeFlaMenuPrompt } from './fla-menu-command.js';
import { claudeHookTimeoutMs } from './hook-contract.js';

// Claude Code shows the model only a preview (about the first 10,000
// characters) of a hook context longer than that and saves the rest as a file
// (rec#47 F1b). The preferences past the preview are then never seen, and the
// preview is no frame preference-evidence.js can confirm, so every turn
// resends the whole entry. The task entry is bounded to this many characters,
// label included (entry-inline-budget.js, rec#11 D-54); the rest of the 10,000
// is room for a notice appended after it (withOutdatedMcpNotice).
const CLAUDE_ENTRY_INLINE_CHARS = 9000;
// Claude Code resumes a session (`--resume`, `/resume`) by replaying the same
// transcript into the model's context, so the frames delivered before are
// still seen and a resume keeps the delivery base (rec#47, rec#11 D-69).
export const CLAUDE_REPLAYED_SOURCES = Object.freeze(['resume']);

export async function claudeLifecycleOutput(event, input, invoke, { delivery, currentTask, entryRefusal, onCurrentTask } = {}) {
  if (!['UserPromptSubmit', 'Stop', ...PREFERENCE_RESET_EVENTS].includes(event)) throw new TypeError('Unsupported Claude lifecycle event');
  const sessionId = input?.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) {
    throw new TypeError('Claude lifecycle requires a host session identifier');
  }
  const source = { sourceApplication: 'claude_code', sourceSessionId: sessionId };
  if (PREFERENCE_RESET_EVENTS.includes(event)) return withinInlineLimit(event, input, await preferenceLifecycleOutput(event, input,
    { sourceApplication: 'claude_code', delivery, currentTask, invoke, replayedSources: CLAUDE_REPLAYED_SOURCES,
      inlineChars: CLAUDE_ENTRY_INLINE_CHARS }));
  if (event === 'UserPromptSubmit') {
    if (typeof input.cwd !== 'string' || !input.cwd.trim() || typeof input.prompt !== 'string') {
      throw new TypeError('Claude task entry requires cwd and prompt');
    }
    const off = await entryRefusal?.();
    if (claudeTurnOrigin(input) !== 'person') return off ? {} : quietHostTurn(
      () => currentTask?.(input.session_id, 'claude_code'), onCurrentTask);
    if (off) return { hookSpecificOutput: { hookEventName: event, additionalContext: sessionFuliOffContext(off) } };
    const prompt = claudeFlaMenuPrompt(withoutDebugMark(input.prompt));
    // Claude Code's hook does not name the model; its transcript does (session-model.js).
    const clientModel = await claudeSessionModel(input.transcript_path);
    const context = await invoke('begin_task_context', {
      sessionId, projectPath: input.cwd, taskPrompt: prompt.slice(0, 8192), ...source, ...taskSceneInput(prompt),
      ...(clientModel ? { clientModel } : {})
    });
    const entry = compactTaskContext(context);
    return withinInlineLimit(event, input, await preferenceHookOutput(entry, event, input, delivery, 'claude_code',
      'Fuli task context. Apply effective_preferences. ' + taskClosingInstruction(entry) + PASS_TASK_TOKEN + TASK_RULES_ON_DEMAND,
      false, { inlineChars: CLAUDE_ENTRY_INLINE_CHARS, request: prompt }));
  }
  const check = await invoke('verify_task_checkpoint', { sessionId, ...source });
  return stopHookOutcome(check, invoke, source, { reply: input.last_assistant_message,
    turn: () => claudeTurnRecords(input.transcript_path, sessionId) });
}

// The last guard of the inline limit (rec#11 D-72): a context the bounded
// fit could not bring under it, not even as its blocked frame, is never sent;
// the turn gets the unavailable output instead.
function withinInlineLimit(event, input, output) {
  const text = output?.hookSpecificOutput?.additionalContext;
  return typeof text === 'string' && text.length > CLAUDE_ENTRY_INLINE_CHARS
    ? claudeLifecycleUnavailable(event, input, INLINE_LIMIT_UNAVAILABLE) : output;
}

const INLINE_LIMIT_UNAVAILABLE = 'Fuli task context does not fit Claude Code\'s inline limit, not even as a blocked frame; '
  + 'memory recovery and task checkpoint are not verified. Continue with the user request and use Fuli MCP when it becomes available.';

const UNPROTECTED_TURN = unprotectedTurnReason({ zh: '它像宿主通知', en: 'it looks like a host notification' });

export function claudeLifecycleUnavailable(event, input = null, reason = null, incomplete = '', recovery = '') {
  const warning = reason ?? 'Fuli context is unavailable; memory recovery and task checkpoint are not verified. '
    + 'Continue with the user request and use Fuli MCP when it becomes available.' + recovery;
  const sessionId = input?.session_id;
  if (event === 'UserPromptSubmit' && claudeTurnOrigin(input) !== 'person') return {};
  const fallback = typeof sessionId === 'string' && sessionId.trim() && sessionId.length <= 256
    ? ` No valid Hook task context was supplied. First call get_collaboration_preferences with sessionId=${JSON.stringify(sessionId)}, projectPath=current working directory and taskPrompt=current user request. Follow checkpoint_required and checkpoint_guidance; use its fresh taskContextToken for checkpoint_task_knowledge with a truthful workLog when there is something to record. Native transcript capture remains unverified; do not reuse an old token or claim this Hook delivered task context.${incomplete}`
    : '';
  return event === 'UserPromptSubmit'
    ? { systemMessage: warning, hookSpecificOutput: { hookEventName: event, additionalContext: warning + fallback } }
    : { systemMessage: warning };
}

// At the deadline an entry that already wrote its task delivers its token and
// what is missing (entry-budget.js); otherwise the fallback says what to fetch.
export function claudeEntryDeadlineOutput(event, input, budget, recovery = '') {
  if (event === 'UserPromptSubmit' && claudeTurnOrigin(input) !== 'person') return {};
  const partial = event === 'UserPromptSubmit' ? partialEntryText(budget) : null;
  const output = partial ? { systemMessage: 'Fuli task context is partial: the hook deadline came before it was complete.',
    hookSpecificOutput: { hookEventName: event, additionalContext: partial } }
    : claudeLifecycleUnavailable(event, input, null, NO_TASK_AT_DEADLINE, recovery);
  return event === 'UserPromptSubmit' ? withOutdatedMcpNotice(output, entryNotice(budget)) : output;
}

export async function runClaudeLifecycleHook(args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  const input = await (dependencies.readInput ?? readHookInput)();
  if (dependencies.invoke) return claudeLifecycleOutput(event, input, dependencies.invoke);
  const env = dependencies.env ?? process.env;
  const { runtimeConfigPath } = (dependencies.resolveRuntimeOptions ?? resolveGraphRuntimeOptions)(
    args, env, dependencies.cwd === undefined ? {} : { setupPaths: { cwd: dependencies.cwd } }
  );
  const ledger = runtimeConfigPath && typeof input?.session_id === 'string' && input.session_id.trim()
    ? transcriptCaptureLedger(runtimeConfigPath, input, 'claude_code') : null;
  // How this session was started (Claude Desktop or the CLI), once per
  // session and without starting any process. It never decides this turn's
  // answer, so a failure is only skipped.
  if (ledger) {
    try {
      recordClaudeSessionClient({ runtimeConfigPath, sessionId: input.session_id, env });
    } catch { /* the console classifies the session from its source application */ }
  }
  // Noted before the entry runs, so an answer at the deadline carries it too.
  const notice = noteEntryNotice(() => outdatedMcpNotice(runtimeConfigPath,
    { sourceApplication: 'claude_code', version: FULI_VERSION, sessionId: input?.session_id }));
  // A turn whose ownership cannot be proven is held as unresolved before
  // anything else can fail or return: whatever the read below finds, its
  // Stop neither settles the session's task nor records the turn under it.
  const heldTurn = event === 'UserPromptSubmit' && claudeTurnOrigin(input) !== 'person' ? randomUUID() : null;
  if (heldTurn && !ledger?.holdTurn({ turn: heldTurn, from: turnStart(input.transcript_path) })) {
    return { decision: 'block', reason: UNPROTECTED_TURN };
  }
  let app;
  let leases;
  const closing = new Map();
  // Also called at the hook's deadline (runClaudeLifecycleEvent): the lease
  // and its heartbeat end and the stores close, so work that ignored
  // cancellation fails at its next use instead of holding them. Each is
  // closed once, whichever comes first.
  const closeOnce = resource => {
    if (resource && !closing.has(resource)) closing.set(resource, close(resource));
    return closing.get(resource);
  };
  const cleanup = () => Promise.allSettled([closeOnce(leases), closeOnce(app)]);
  dependencies.onCleanup?.(cleanup);
  try {
    app = (dependencies.openApplication ?? openFederatedGraphApplication)({ runtimeConfigPath, env });
    leases = (dependencies.createLeases ?? createRuntimeLeaseClient)({ runtimeConfigPath });
    const request = { signal: dependencies.signal, testToolsEnabled: testToolsEnabled(env) };
    const output = await leases.withGraphLease('claude-code-lifecycle', () => withCaptureLookups(async () => {
      // The person's /fuli line is answered here and never reaches the model.
      const command = !heldTurn && event === 'UserPromptSubmit' ? await sessionFuliCommandResult(app, { sessionId: input.session_id,
        sourceApplication: 'claude_code', prompt: input.prompt, projectPath: input.cwd }) : null;
      if (claudeSessionBegins(event, input)) sessionFuliSessionBegan(app, { sessionId: input.session_id, sourceApplication: 'claude_code' });
      if (command) return claudeSessionCommandOutput(command);
      const call = (name, parameters) => (dependencies.callTool ?? callAgentTool)(app, name, parameters, request);
      const currentTask = app.taskContextRegistry?.current?.bind(app.taskContextRegistry);
      const entryRefusal = () => sessionFuliEntryRefusal(app, { sessionId: input.session_id, sourceApplication: 'claude_code' });
      // A host notification begins no task and claims no transcript boundary. Its turn
      // stays held through a session reset, compaction or FULI going off, until
      // an explicit resolution in a later Stop's turn or a fresh task entry.
      if (heldTurn) return claudeLifecycleOutput(event, input, call, { currentTask,
        entryRefusal, onCurrentTask: task => ledger.ownTurn(heldTurn, transcriptDigest(task.token)) });
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
    const delivered = !heldTurn && event === 'UserPromptSubmit'
      ? withDebugMarkNotice(withOutdatedMcpNotice(output, notice()), input?.prompt) : output;
    await recordDebugTurn({ runtimeConfigPath, sourceApplication: 'claude_code', event, input,
      output: delivered, adapter: CLAUDE_TRANSCRIPT }, debugTurnLog(dependencies));
    return delivered;
  } catch (error) {
    await recordDebugTurn({ runtimeConfigPath, sourceApplication: 'claude_code', event, input,
      output: { hookFailed: hookFailureCause(error) }, adapter: CLAUDE_TRANSCRIPT }, debugTurnLog(dependencies));
    throw error;
  } finally {
    await cleanup();
  }
}

const CLAUDE_TRANSCRIPT = Object.freeze({ normalize: normalizeClaudeRecord, verify: verifyClaudeTranscript });

// Claude Code's policy for unresolved turns (unresolved-turns.js): a
// successful checkpoint_task_knowledge with the task's token in the turn,
// recorded by the host, proves the turn belongs to that task (turn-ownership.js).
const CLAUDE_UNRESOLVED_TURNS = Object.freeze({
  sourceApplication: 'claude_code', adapter: CLAUDE_TRANSCRIPT,
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

// The #fulidebug recorder's line goes to the caller's stderr, not this process's.
function debugTurnLog({ log }) { return log ? { log } : {}; }

// One installed hook call (lifecycle-events.js): the command line, the
// environment it runs with, its working directory and its stdin chunks, to
// what it prints and its exit code. Nothing here reads this process's argv,
// environment, working directory or stdin, so the console can run many at once.
// It answers by the hook's own deadline (or the shorter timeoutMs left of it),
// even when a dependency ignores cancellation or stdin never closes; at the
// deadline the work is cancelled and its lease and stores are closed, not
// awaited. onSettled runs once the work has ended.
export function runClaudeLifecycleEvent({ argv, env, cwd, stdin, timeoutMs: remainingMs }, { onSettled = () => {} } = {}) {
  const args = [...argv];
  const event = args[args.indexOf('--event') + 1];
  const timeoutMs = Math.min(claudeHookTimeoutMs(args), remainingMs ?? Infinity);
  let cleanup = async () => {};
  const controller = new AbortController();
  const startedAt = Date.now();
  const stderr = [];
  let input = null;
  // No prompt, transcript, path or raw exception is written to diagnostics.
  const runtimeConfigPath = () => runtimeConfigPathOf(args, env, cwd);
  const recovery = (error = null) => consoleRecoveryNotice(runtimeConfigPath(), error);
  return new Promise(resolve => {
    let emitted = false;
    const emit = output => {
      if (emitted) return;
      emitted = true;
      resolve({ stdout: `${JSON.stringify(output)}\n`, stderr: stderr.join(''), exitCode: 0 });
    };
    // Finish before the host timeout, even if a dependency ignores cancellation.
    // The entry's own time ends where its requests are cancelled.
    const abortAfterMs = Math.max(1, timeoutMs - 1500);
    const budget = entryBudget(abortAfterMs);
    const deadline = setTimeout(() => {
      controller.abort();
      emit(claudeEntryDeadlineOutput(event, input, budget, recovery()));
      void cleanup();
    }, timeoutMs);
    const abort = setTimeout(() => controller.abort(), abortAfterMs);
    runWithEntryBudget(budget, () => runClaudeLifecycleHook(args, { signal: controller.signal, env, cwd,
      captureTimeoutMs: Math.max(1, Math.min(750, Math.floor(timeoutMs / 4))),
      log: line => { stderr.push(`${line}\n`); }, onCleanup: close => { cleanup = close; },
      readInput: async () => { input = await readHookInput(stdin); return input; } }))
      .then(emit, error => {
        emit(controller.signal.aborted ? claudeEntryDeadlineOutput(event, input, budget, recovery())
          : claudeLifecycleUnavailable(event, input, null, '', recovery(error)));
        recordHookFailure({ runtimeConfigPath: runtimeConfigPath(), client: 'claude_code', event, error,
          sessionId: input?.session_id, startedAt });
      })
      .finally(() => {
        clearTimeout(abort);
        clearTimeout(deadline);
        onSettled();
      });
  });
}

// What the hook answers when the console took its call and then failed or
// went silent (lifecycle-forwarder.js): the event may have run there, so it is
// never run again here; the turn gets the same unavailable answer as a hook
// whose work failed.
export function claudeLifecycleEventLost({ argv, env, cwd, stdin }, error) {
  const args = [...argv];
  const event = args[args.indexOf('--event') + 1];
  let input = null;
  try { input = parseHookInput(Buffer.concat(stdin)); } catch { /* answered without a session */ }
  const runtimeConfigPath = runtimeConfigPathOf(args, env, cwd);
  recordHookFailure({ runtimeConfigPath, client: 'claude_code', event, error, sessionId: input?.session_id });
  const output = claudeLifecycleUnavailable(event, input, null, '', consoleRecoveryNotice(runtimeConfigPath));
  return { stdout: `${JSON.stringify(output)}\n`, stderr: '', exitCode: 0 };
}
