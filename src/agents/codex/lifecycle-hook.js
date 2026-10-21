#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { PASS_TASK_TOKEN, TASK_RULES_ON_DEMAND } from '../lifecycle-message.js';
import { outdatedMcpNotice, withOutdatedMcpNotice } from '../../mcp/process-registry.js';
import { FULI_VERSION } from '../../package-metadata.js';
import { transcriptLifecycle } from '../../conversations/transcript-lifecycle.js';
import { compactTaskContext } from '../../conversations/task-context-view.js';
import { PREFERENCE_RESET_EVENTS, preferenceHookOutput, preferenceLifecycleOutput } from '../../conversations/preference-lifecycle.js';
import { isSystemPromptEntry } from '../system-prompt.js';
import { endTurnsObservedAtEntry, refreshCurrentTaskInPlace, settleHeldTurns, START_NEW_WORK, turnStart,
  unprotectedTurnReason } from '../../conversations/unresolved-turns.js';
import { transcriptCaptureLedger } from '../../conversations/transcript-capture-gap.js';
import { transcriptDigest } from '../../conversations/transcript-guard.js';
import { normalizeCodexRecord, verifyCodexTranscript } from './conversation-transcript.js';
import { CODEX_REVIEW_OFF_REASON, CODEX_REVIEW_UNVERIFIED_REASON, isCodexReviewCommand, withCodexReviewGuidance } from './review-command.js';
import { sessionFuliCommandResult, sessionFuliEntryRefusal, sessionFuliOffContext, sessionFuliSessionBegan }
  from '../../conversations/session-fuli-entry.js';

import { callAgentTool } from '../../agent-tools.js';
import { createRuntimeLeaseClient } from '../../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../../graphiti/runtime-config.js';
import { isMainModule } from '../../system/main-module.js';
import { readHookInput } from '../lifecycle-input.js';
import { stopHookOutcome } from '../../conversations/stop-auto-close.js';

// Task entry gets longer: a warm entry already takes 2–4 s on a Mac and a cold
// first one ran past 5 s, which costs the model two fallback requests. Both
// stay well inside the host's 30 s hook timeout.
const ENTRY_TIMEOUT_MS = 15_000;
const OTHER_TIMEOUT_MS = 5_000;

export function codexHookTimeoutMs(args) {
  const event = args[args.indexOf('--event') + 1];
  const limit = event === 'UserPromptSubmit' ? ENTRY_TIMEOUT_MS : OTHER_TIMEOUT_MS;
  const configured = Number(args[args.indexOf('--timeout-ms') + 1]);
  return args.includes('--timeout-ms') && Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, limit) : limit;
}

export async function codexStopLifecycleOutput(input, invoke) {
  const sessionId = input?.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) {
    throw new TypeError('Codex Stop hook requires a host session identifier');
  }
  const check = await invoke('verify_task_checkpoint', {
    sessionId,
    sourceApplication: 'codex',
    sourceSessionId: sessionId
  });
  // Never force another model turn. A hook-delivered task with no checkpoint
  // is closed as honestly reported retain_nothing; others get the reminder.
  return stopHookOutcome(check, invoke, { sourceApplication: 'codex', sourceSessionId: sessionId });
}

export async function codexLifecycleOutput(event, input, invoke, { delivery, currentTask, entryRefusal, onCurrentTask } = {}) {
  if (PREFERENCE_RESET_EVENTS.includes(event)) return preferenceLifecycleOutput(event, input,
    { sourceApplication: 'codex', delivery, currentTask, invoke });
  if (event === 'Stop') return codexStopLifecycleOutput(input, invoke);
  if (!input?.session_id || typeof input.cwd !== 'string' || typeof input.prompt !== 'string') {
    throw new TypeError('Codex task entry requires session, cwd and prompt');
  }
  const review = isCodexReviewCommand(input.prompt);
  // A session FULI is off for (rec#5 C3b) gets no task entry, no refresh and no review.
  const off = await entryRefusal?.();
  if (off && review) return { decision: 'block', reason: CODEX_REVIEW_OFF_REASON };
  if (off) return { hookSpecificOutput: { hookEventName: event, additionalContext: sessionFuliOffContext(off) } };
  if (codexRefreshTurn(event, input)) return refreshCurrentTaskInPlace(event, input, invoke, { sourceApplication: 'codex',
    delivery, currentTask, onCurrentTask, unconfirmed: UNCONFIRMED_TURN });
  const context = await invoke('begin_task_context', { sessionId: input.session_id,
    turnId: input.turn_id ?? null, projectPath: input.cwd, taskPrompt: input.prompt.slice(0, 8192),
    sourceApplication: 'codex', sourceSessionId: input.session_id });
  const output = await preferenceHookOutput(compactTaskContext(context), event, input, delivery, 'codex',
    'Fuli task context. Apply effective_preferences. Follow checkpoint_guidance: checkpoint with taskContextToken only when there is something to record; the Stop hook closes the rest. ' + PASS_TASK_TOKEN + TASK_RULES_ON_DEMAND);
  return review ? withCodexReviewGuidance(output) : output;
}

export async function runCodexLifecycleHook(args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  if (!['Stop', 'UserPromptSubmit', ...PREFERENCE_RESET_EVENTS].includes(event)) throw new TypeError('Missing Codex lifecycle event');
  const input = await (dependencies.readInput ?? readHookInput)();
  const write = dependencies.write ?? ((value) => process.stdout.write(value));
  if (dependencies.invoke) {
    const output = await codexLifecycleOutput(event, input, dependencies.invoke);
    write(`${JSON.stringify(output)}\n`);
    return output;
  }

  const resolveRuntimeOptions = dependencies.resolveRuntimeOptions ?? resolveGraphRuntimeOptions;
  const { runtimeConfigPath } = resolveRuntimeOptions(
    args,
    dependencies.env ?? process.env
  );
  const ledger = runtimeConfigPath && typeof input?.session_id === 'string' && input.session_id.trim()
    ? transcriptCaptureLedger(runtimeConfigPath, input, 'codex') : null;
  // A turn whose ownership cannot be proven is held as unresolved before
  // anything else can fail or return: whatever the read below finds, its
  // Stop neither settles the session's task nor records the turn under it.
  const refreshTurn = codexRefreshTurn(event, input) ? randomUUID() : null;
  if (refreshTurn && !ledger?.holdTurn({ turn: refreshTurn, from: turnStart(input.transcript_path) })) {
    const output = { decision: 'block', reason: UNPROTECTED_TURN };
    write(`${JSON.stringify(output)}\n`);
    return output;
  }
  let app;
  let leases;
  let closing;
  const cleanup = () => closing ??= Promise.allSettled([closeQuietly(leases), closeQuietly(app)]);
  dependencies.onCleanup?.(cleanup);
  try {
    app = (dependencies.openApplication ?? openFederatedGraphApplication)({
      runtimeConfigPath
    });
    leases = (dependencies.createLeases ?? createRuntimeLeaseClient)({
      runtimeConfigPath
    });
    const invokeTool = dependencies.callTool ?? callAgentTool;
    const output = await leases.withGraphLease('codex-lifecycle', async () => {
      // The person's fuli line is answered here and never reaches the model.
      const command = event === 'UserPromptSubmit' ? await sessionFuliCommandResult(app, { sessionId: input?.session_id,
        sourceApplication: 'codex', prompt: input?.prompt, projectPath: input?.cwd ?? null }) : null;
      if (codexSessionBegins(event, input)) sessionFuliSessionBegan(app, { sessionId: input.session_id, sourceApplication: 'codex' });
      if (command) return codexSessionCommandOutput(command);
      const call = (name, parameters) => invokeTool(app, name, parameters, { signal: dependencies.signal });
      const currentTask = app.taskContextRegistry?.current?.bind(app.taskContextRegistry);
      const entryRefusal = () => sessionFuliEntryRefusal(app, { sessionId: input.session_id, sourceApplication: 'codex' });
      // A refresh begins no task and claims no transcript boundary. Its turn
      // stays held through a session reset, compaction or FULI going off,
      // until another task, or none, is current at a Stop, or a fresh entry.
      if (refreshTurn) return codexLifecycleOutput(event, input, call, { delivery: app.preferenceDelivery, currentTask,
        entryRefusal, onCurrentTask: task => ledger.ownTurn(refreshTurn, transcriptDigest(task.token)) });
      if (PREFERENCE_RESET_EVENTS.includes(event)) return codexLifecycleOutput(event, input, call,
        { delivery: app.preferenceDelivery, currentTask });
      // No continuation evidence is passed: see CODEX_CONTINUATION_UNPROVABLE.
      const unresolved = event === 'Stop' && await settleHeldTurns(app, ledger, input, currentTask,
        { sourceApplication: 'codex', adapter: CODEX_TRANSCRIPT }) === 'held';
      // Turns held when this prompt starts end once it freshly enters a task.
      const held = event === 'UserPromptSubmit' ? ledger?.entrySnapshot() : null;
      let entered = false;
      const lifecycle = await transcriptLifecycle({ application: app, runtimeConfigPath, input, event, sourceApplication: 'codex',
        captureTimeoutMs: dependencies.captureTimeoutMs, signal: dependencies.signal, adapter: CODEX_TRANSCRIPT,
        // An unresolved turn's Stop neither verifies nor closes the task; its sync skips the turn.
        run: onContext => unresolved ? Promise.resolve({}) : codexLifecycleOutput(event, input, async (name, parameters) => {
          const context = await call(name, parameters);
          if (name === 'begin_task_context') { entered = true; onContext(context); }
          return context;
        }, { delivery: app.preferenceDelivery, entryRefusal }) });
      if (entered) await endTurnsObservedAtEntry(ledger, held, input, CODEX_TRANSCRIPT);
      return lifecycle;
    }, { signal: dependencies.signal });
    const delivered = event === 'UserPromptSubmit' ? withOutdatedMcpNotice(output, outdatedMcpNotice(runtimeConfigPath,
      { sourceApplication: 'codex', version: FULI_VERSION, sessionId: input?.session_id })) : output;
    write(`${JSON.stringify(delivered)}\n`);
    return delivered;
  } finally {
    await cleanup();
  }
}

const CODEX_TRANSCRIPT = Object.freeze({ normalize: normalizeCodexRecord, verify: verifyCodexTranscript });

// rec#28: no field of Codex's hook input proves that the host, not the
// person, sent a turn. UserPromptSubmit input is exactly session_id, turn_id,
// agent_id, agent_type, transcript_path, cwd, hook_event_name, model,
// permission_mode and prompt (openai/codex deede7201da2:
// codex-rs/hooks/src/schema.rs 566-584, deny_unknown_fields; the generated
// user-prompt-submit.command.input.schema.json has additionalProperties
// false): Codex never writes isMeta or is_meta. The hook runs for every
// user-input turn (codex-rs/core/src/hook_runtime.rs 677-713), including
// prompts Codex synthesizes itself such as a review
// (codex-rs/core/src/session/review.rs 142-150), and nothing in the input
// tells those apart. So a turn marked isMeta or is_meta did not come from
// Codex's documented input and its source is unprovable: it takes the
// conservative path of unresolved-turns.js, never a trusted shortcut. Every
// other prompt enters as before.
function codexRefreshTurn(event, input) {
  return event === 'UserPromptSubmit' && isSystemPromptEntry(input);
}

// CODEX_CONTINUATION_UNPROVABLE: no held Codex turn is ever proven an
// explicit continuation. The rollout keeps an MCP call's output
// (response_item function_call_output) without whether it succeeded
// (openai/codex deede7201da2: codex-rs/protocol/src/models.rs 2341-2347,
// success is not serialized), and the records that do carry it depend on the
// thread's history mode (codex-rs/rollout/src/policy.rs). A held Codex turn
// therefore ends only when another task, or none, is current at a Stop (its
// span is skipped, never imported) or when a fresh task entry ends it.

// Bilingual: the person reads these in the transcript as well as the model.
const UNCONFIRMED_TURN = 'FULI：本轮输入带有 isMeta 标记，但 Codex 的 hook 输入不定义这个字段，无法证明它来自宿主；'
  + '来源和任务归属都未确认，没有创建或切换任务。 FULI: this turn carries an isMeta mark, but Codex hook input does not '
  + 'define that field, so nothing proves the host sent it; its source and task ownership are not confirmed; no task was created or switched.';
const UNPROTECTED_TURN = unprotectedTurnReason({ zh: '它带有 Codex 不定义的 isMeta 标记',
  en: 'it carries an isMeta mark that Codex does not define' });

// Codex sends SessionStart source "startup" only for a new thread
// (openai/codex 87f3c3284e16: codex-rs/core/src/session/session.rs 1974-1977,
// InitialHistory::New); resume, clear, compact and fork are not taken as proof.
function codexSessionBegins(event, input) {
  return event === 'SessionStart' && input?.source === 'startup' && typeof input.session_id === 'string';
}

// Codex shows a blocked prompt's reason as "Blocked by hook" and keeps the
// prompt out of the conversation.
function codexSessionCommandOutput(result) {
  return { decision: 'block', reason: `FULI: ${result.message}` };
}

async function closeQuietly(resource) {
  try {
    await resource?.close();
  } catch {
    // Cleanup diagnostics may contain local paths. The lifecycle adapter fails open.
  }
}


// The cause says whether the hook ran out of time or failed, so a report can
// tell a slow first start from a broken install without exposing details.
function codexLifecycleUnavailable(event, input, cause) {
  // The person's review line never reaches the model unverified (rec#22).
  if (event === 'UserPromptSubmit' && isCodexReviewCommand(input?.prompt)) {
    return { decision: 'block', reason: CODEX_REVIEW_UNVERIFIED_REASON };
  }
  const warning = `Fuli context is unavailable (${cause}). Continue with the user request; saved context and checkpoint were not verified.`;
  // A refresh turn is never told to begin a task for "the current user request".
  if (codexRefreshTurn(event, input)) return { systemMessage: warning, hookSpecificOutput: {
    hookEventName: event, additionalContext: `${warning} ${START_NEW_WORK}` } };
  const sessionId = input?.session_id;
  if (event !== 'UserPromptSubmit' || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) {
    return { systemMessage: warning };
  }
  // The host supplied this identity before the failure. A process-local MCP
  // session cannot replace it when the Agent falls back to the preferences tool.
  const fallback = ` No valid Hook task context was supplied. First call get_collaboration_preferences with sessionId=${JSON.stringify(sessionId)}, projectPath=current working directory and taskPrompt=current user request. Follow checkpoint_required and checkpoint_guidance; use its fresh taskContextToken for checkpoint_task_knowledge with a truthful workLog when there is something to record. Native transcript capture remains unverified; do not reuse an old token or claim this Hook delivered task context.`;
  return { systemMessage: warning, hookSpecificOutput: {
    hookEventName: event, additionalContext: warning + fallback
  } };
}

export async function runCodexLifecycleCommand(args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  const timeoutMs = codexHookTimeoutMs(args);
  const controller = new AbortController();
  let emitted = false;
  const write = value => {
    if (emitted) return;
    emitted = true;
    (dependencies.write ?? (value => process.stdout.write(value)))(value);
  };
  let input = null;
  const readInput = dependencies.readInput ?? readHookInput;
  const unavailable = cause => `${JSON.stringify(codexLifecycleUnavailable(event, input, cause))}\n`;
  let cleanup = async () => {};
  let deadline;
  const expired = new Promise(resolve => {
    deadline = setTimeout(async () => {
      controller.abort();
      write(unavailable(`no answer within ${timeoutMs} ms`));
      // A broken dependency must not hold the host open. Give opened leases
      // and connections a bounded chance to close before the process exits.
      let grace;
      await Promise.race([cleanup(), new Promise(done => { grace = setTimeout(done, 250); })]);
      clearTimeout(grace);
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  try {
    const running = runCodexLifecycleHook(args, { ...dependencies, signal: controller.signal, write,
      captureTimeoutMs: Math.max(1, Math.min(750, Math.floor(timeoutMs / 4))),
      readInput: async () => { input = await readInput(); return input; },
      onCleanup: close => { cleanup = close; } }).then(() => ({ timedOut: false }), () => {
      // Never print prompts, transcripts, paths or credentials.
      write(unavailable('the hook failed'));
      return { timedOut: false };
    });
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(deadline);
  }
}

if (isMainModule(import.meta.url)) {
  const result = await runCodexLifecycleCommand(process.argv.slice(2));
  if (result.timedOut) process.exit(0);
}
