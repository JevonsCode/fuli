import { randomUUID } from 'node:crypto';
import { hookFailureCause, PASS_TASK_TOKEN, TASK_RULES_ON_DEMAND, taskClosingInstruction } from '../lifecycle-message.js';
import { consoleRecoveryNotice, recordHookFailure, runtimeConfigPathOf } from '../lifecycle-failure.js';
import { outdatedMcpNotice, withOutdatedMcpNotice } from '../../mcp/process-registry.js';
import { FULI_VERSION } from '../../package-metadata.js';
import { transcriptLifecycle } from '../../conversations/transcript-lifecycle.js';
import { compactTaskContext } from '../../conversations/task-context-view.js';
import { PREFERENCE_RESET_EVENTS, preferenceHookOutput, preferenceLifecycleOutput } from '../../conversations/preference-lifecycle.js';
import { isSystemPromptEntry } from '../system-prompt.js';
import { endTurnsObservedAtEntry, quietHostTurn, settleHeldTurns, turnStart,
  unprotectedTurnReason } from '../../conversations/unresolved-turns.js';
import { transcriptCaptureLedger } from '../../conversations/transcript-capture-gap.js';
import { transcriptDigest } from '../../conversations/transcript-guard.js';
import { normalizeCodexRecord, verifyCodexTranscript } from './conversation-transcript.js';
import { sessionFuliCommandResult, sessionFuliEntryRefusal, sessionFuliOffContext, sessionFuliSessionBegan }
  from '../../conversations/session-fuli-entry.js';

import { callAgentTool } from '../../agent-tools.js';
import { createRuntimeLeaseClient } from '../../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../../graphiti/runtime-config.js';
import { testToolsEnabled } from '../../app/test-tools.js';
import { parseHookInput, readHookInput } from '../lifecycle-input.js';
import { stopHookOutcome } from '../../conversations/stop-auto-close.js';
import { taskSceneInput } from '../../graphiti/task-scene.js';
import { entryBudget, entryNotice, noteEntryNotice, NO_TASK_AT_DEADLINE, partialEntryText, runWithEntryBudget } from '../../conversations/entry-budget.js';
import { recordDebugTurn } from '../../debug-turns/recorder.js';
import { DEBUG_MARK_NOTICE, isDebugPrompt, withDebugMarkNotice, withoutDebugMark } from '../../debug-turns/trigger.js';
import { codexHookTimeoutMs } from './hook-contract.js';

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
  return stopHookOutcome(check, invoke, { sourceApplication: 'codex', sourceSessionId: sessionId }, { reply: input?.last_assistant_message });
}

// Codex keeps about 2,500 tokens of a hook context, which it counts as UTF-8
// bytes / 4 (so about 10,000 bytes), and records a longer one as its head and
// tail around a cut, the whole text spilled to a file (Codex rollouts: every
// context of 2,559 tokens or more kept 2,458 of them; none of 9,253 bytes or
// fewer was cut). These are one computer's records: another model or Codex
// configuration may keep less, and a frame the host cuts all the same is not
// detected yet (a follow-up). The preferences in the cut are never seen, and
// the cut preview is no frame preference-evidence.js can confirm, so every
// turn resent the whole entry (a real-scale working entry: 41k characters,
// 64k bytes). As Claude Code's (claude-code/lifecycle-event.js), the task
// entry and the restore after a compaction are bounded
// to this many bytes, label included. Measured in bytes, not characters: a
// Chinese character is three of them.
export const CODEX_ENTRY_INLINE_BYTES = 9000;
// The whole context Codex is given, the notices the hook appends after the
// entry included (withOutdatedMcpNotice, withDebugMarkNotice): under the
// 9,253 bytes it was seen to keep whole. A turn with notices gives the entry
// this less what they take (codexEntryBytes).
export const CODEX_CONTEXT_BYTES = 9200;

// The entry's limit on a turn whose hook appends `notice` and, for a
// #fulidebug prompt, the debug mark's line, each after a newline.
export function codexEntryBytes(notice, prompt) {
  const appended = (notice ? 1 + Buffer.byteLength(notice) : 0)
    + (isDebugPrompt(prompt) ? 1 + Buffer.byteLength(DEBUG_MARK_NOTICE) : 0);
  return Math.min(CODEX_ENTRY_INLINE_BYTES, CODEX_CONTEXT_BYTES - appended);
}

// `inlineBytes`: the entry's limit on this turn (codexEntryBytes).
export async function codexLifecycleOutput(event, input, invoke, { delivery, currentTask, entryRefusal, onCurrentTask,
  inlineBytes = CODEX_ENTRY_INLINE_BYTES } = {}) {
  if (PREFERENCE_RESET_EVENTS.includes(event)) return preferenceLifecycleOutput(event, input,
    { sourceApplication: 'codex', delivery, currentTask, invoke, inlineBytes });
  if (event === 'Stop') return codexStopLifecycleOutput(input, invoke);
  if (!input?.session_id || typeof input.cwd !== 'string' || typeof input.prompt !== 'string') {
    throw new TypeError('Codex task entry requires session, cwd and prompt');
  }
  const off = await entryRefusal?.();
  if (codexTurnOrigin(event, input) !== 'person') return off ? {} : quietHostTurn(
    () => currentTask?.(input.session_id, 'codex'), onCurrentTask);
  if (off) return { hookSpecificOutput: { hookEventName: event, additionalContext: sessionFuliOffContext(off) } };
  const context = await invoke('begin_task_context', { sessionId: input.session_id,
    turnId: input.turn_id ?? null, projectPath: input.cwd, taskPrompt: withoutDebugMark(input.prompt).slice(0, 8192),
    sourceApplication: 'codex', sourceSessionId: input.session_id, ...taskSceneInput(withoutDebugMark(input.prompt)),
    // Codex names the session's model in its prompt hook input; a #FLG join records it (rec#129).
    ...(typeof input.model === 'string' && input.model.trim() ? { clientModel: input.model.trim().slice(0, 120) } : {}) });
  const entry = compactTaskContext(context);
  return preferenceHookOutput(entry, event, input, delivery, 'codex',
    'Fuli task context. Apply effective_preferences. ' + taskClosingInstruction(entry) + PASS_TASK_TOKEN + TASK_RULES_ON_DEMAND,
    false, { inlineBytes, request: withoutDebugMark(input.prompt) });
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

  const env = dependencies.env ?? process.env;
  const resolveRuntimeOptions = dependencies.resolveRuntimeOptions ?? resolveGraphRuntimeOptions;
  const { runtimeConfigPath } = resolveRuntimeOptions(
    args, env, dependencies.cwd === undefined ? {} : { setupPaths: { cwd: dependencies.cwd } }
  );
  const ledger = runtimeConfigPath && typeof input?.session_id === 'string' && input.session_id.trim()
    ? transcriptCaptureLedger(runtimeConfigPath, input, 'codex') : null;
  // Noted before the entry runs, so an answer at the deadline carries it too.
  const notice = noteEntryNotice(() => outdatedMcpNotice(runtimeConfigPath,
    { sourceApplication: 'codex', version: FULI_VERSION, sessionId: input?.session_id }));
  // A turn whose ownership cannot be proven is held as unresolved before
  // anything else can fail or return: whatever the read below finds, its
  // Stop neither settles the session's task nor records the turn under it.
  const heldTurn = codexTurnOrigin(event, input) !== 'person' ? randomUUID() : null;
  if (heldTurn && !ledger?.holdTurn({ turn: heldTurn, from: turnStart(input.transcript_path) })) {
    const output = { decision: 'block', reason: UNPROTECTED_TURN };
    write(`${JSON.stringify(output)}\n`);
    return output;
  }
  // The entry keeps room for what is appended after it (CODEX_CONTEXT_BYTES).
  const inlineBytes = !heldTurn && event === 'UserPromptSubmit' ? codexEntryBytes(notice(), input?.prompt) : CODEX_ENTRY_INLINE_BYTES;
  let app;
  let leases;
  // Also called at the hook's deadline; each is closed once, whichever comes
  // first, so one opened after an early cleanup still closes.
  const closing = new Map();
  const closeOnce = resource => {
    if (resource && !closing.has(resource)) closing.set(resource, closeQuietly(resource));
    return closing.get(resource);
  };
  const cleanup = () => Promise.allSettled([closeOnce(leases), closeOnce(app)]);
  dependencies.onCleanup?.(cleanup);
  try {
    app = (dependencies.openApplication ?? openFederatedGraphApplication)({
      runtimeConfigPath, env
    });
    leases = (dependencies.createLeases ?? createRuntimeLeaseClient)({
      runtimeConfigPath
    });
    const invokeTool = dependencies.callTool ?? callAgentTool;
    const output = await leases.withGraphLease('codex-lifecycle', async () => {
      // The person's fuli line is answered here and never reaches the model.
      const command = !heldTurn && event === 'UserPromptSubmit' ? await sessionFuliCommandResult(app, { sessionId: input?.session_id,
        sourceApplication: 'codex', prompt: input?.prompt, projectPath: input?.cwd ?? null }) : null;
      if (codexSessionBegins(event, input)) sessionFuliSessionBegan(app, { sessionId: input.session_id, sourceApplication: 'codex' });
      if (command) return codexSessionCommandOutput(command);
      const call = (name, parameters) => invokeTool(app, name, parameters,
        { signal: dependencies.signal, testToolsEnabled: testToolsEnabled(env) });
      const currentTask = app.taskContextRegistry?.current?.bind(app.taskContextRegistry);
      const entryRefusal = () => sessionFuliEntryRefusal(app, { sessionId: input.session_id, sourceApplication: 'codex' });
      // A host notification begins no task and claims no transcript boundary. Its turn
      // stays held through a session reset, compaction or FULI going off,
      // until another task, or none, is current at a Stop, or a fresh entry.
      if (heldTurn) return codexLifecycleOutput(event, input, call, { currentTask,
        entryRefusal, onCurrentTask: task => ledger.ownTurn(heldTurn, transcriptDigest(task.token)) });
      if (PREFERENCE_RESET_EVENTS.includes(event)) return codexLifecycleOutput(event, input, call,
        { delivery: app.preferenceDelivery, currentTask });
      const unresolved = event === 'Stop'
        && await settleHeldTurns(app, ledger, input, currentTask, CODEX_UNRESOLVED_TURNS) === 'held';
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
        }, { delivery: app.preferenceDelivery, entryRefusal, inlineBytes }) });
      if (entered) await endTurnsObservedAtEntry(ledger, held, input, CODEX_UNRESOLVED_TURNS);
      return lifecycle;
    }, { signal: dependencies.signal });
    const delivered = !heldTurn && event === 'UserPromptSubmit'
      ? withDebugMarkNotice(withOutdatedMcpNotice(output, notice()), input?.prompt) : output;
    write(`${JSON.stringify(delivered)}\n`);
    // After the host has its answer; a #fulidebug record never changes or delays it.
    await recordDebugTurn({ runtimeConfigPath, sourceApplication: 'codex', event, input, output: delivered, adapter: CODEX_TRANSCRIPT },
      debugTurnLog(dependencies));
    return delivered;
  } catch (error) {
    await recordDebugTurn({ runtimeConfigPath, sourceApplication: 'codex', event, input,
      output: { hookFailed: hookFailureCause(error) }, adapter: CODEX_TRANSCRIPT }, debugTurnLog(dependencies));
    throw error;
  } finally {
    await cleanup();
  }
}

const CODEX_TRANSCRIPT = Object.freeze({ normalize: normalizeCodexRecord, verify: verifyCodexTranscript });

// rec#28, from the source at openai/codex deede7201da2 only (no other version
// and no real client was checked): no field of Codex's hook input proves that
// the host, not the person, sent a turn. There, UserPromptSubmit input is
// exactly session_id, turn_id, agent_id, agent_type, transcript_path, cwd,
// hook_event_name, model, permission_mode and prompt
// (codex-rs/hooks/src/schema.rs 566-584, deny_unknown_fields; the generated
// user-prompt-submit.command.input.schema.json has additionalProperties
// false), with no isMeta or is_meta. The hook runs for every user-input turn
// (codex-rs/core/src/hook_runtime.rs 677-713), including prompts Codex
// synthesizes itself such as a review (codex-rs/core/src/session/review.rs
// 142-150), and nothing in the input tells those apart. So the source of a
// turn marked isMeta or is_meta is unprovable: it takes the conservative path
// of unresolved-turns.js, never a trusted shortcut. Every other prompt enters
// as before.
function codexTurnOrigin(event, input) {
  return event === 'UserPromptSubmit' && isSystemPromptEntry(input) ? 'host_system' : 'person';
}

// Codex's policy for unresolved turns (unresolved-turns.js). It has no
// continuedInTurn: no held Codex turn is ever proven an explicit continuation.
// At deede7201da2 the rollout keeps an MCP call's output (response_item
// function_call_output) without whether it succeeded
// (codex-rs/protocol/src/models.rs 2341-2347, success is not serialized), and
// the records that do carry it depend on the thread's history mode
// (codex-rs/rollout/src/policy.rs). The held turn ends only after another
// task or none becomes current at Stop, or a fresh task entry ends it.
const CODEX_UNRESOLVED_TURNS = Object.freeze({
  sourceApplication: 'codex', adapter: CODEX_TRANSCRIPT
});
const UNPROTECTED_TURN = unprotectedTurnReason({ zh: '它带有无法证明来源的 isMeta 标记',
  en: 'it carries an isMeta mark whose source cannot be proven' });

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
function codexLifecycleUnavailable(event, input, cause, incomplete = '', recovery = '') {
  const warning = `Fuli context is unavailable (${cause}). Continue with the user request; saved context and checkpoint were not verified.${recovery}`;
  if (codexTurnOrigin(event, input) !== 'person') return {};
  const sessionId = input?.session_id;
  if (event !== 'UserPromptSubmit' || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) {
    return { systemMessage: warning };
  }
  // The host supplied this identity before the failure. A process-local MCP
  // session cannot replace it when the Agent falls back to the preferences tool.
  const fallback = ` No valid Hook task context was supplied. First call get_collaboration_preferences with sessionId=${JSON.stringify(sessionId)}, projectPath=current working directory and taskPrompt=current user request. Follow checkpoint_required and checkpoint_guidance; use its fresh taskContextToken for checkpoint_task_knowledge with a truthful workLog when there is something to record. Native transcript capture remains unverified; do not reuse an old token or claim this Hook delivered task context.`;
  return { systemMessage: warning, hookSpecificOutput: {
    hookEventName: event, additionalContext: warning + fallback + incomplete
  } };
}

// At the deadline an entry that already wrote its task delivers its token and
// what is missing (entry-budget.js); otherwise the fallback says what to fetch.
function codexEntryDeadlineOutput(event, input, budget, cause, recovery = '') {
  if (codexTurnOrigin(event, input) !== 'person') return {};
  const partial = event === 'UserPromptSubmit' ? partialEntryText(budget) : null;
  const output = partial ? { systemMessage: `Fuli task context is partial (${cause}).`,
    hookSpecificOutput: { hookEventName: event, additionalContext: partial } }
    : codexLifecycleUnavailable(event, input, cause, NO_TASK_AT_DEADLINE, recovery);
  return event === 'UserPromptSubmit' ? withOutdatedMcpNotice(output, entryNotice(budget)) : output;
}

export async function runCodexLifecycleCommand(args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  const timeoutMs = Math.min(codexHookTimeoutMs(args), dependencies.timeoutMs ?? Infinity);
  const controller = new AbortController();
  let emitted = false;
  const write = value => {
    if (emitted) return;
    emitted = true;
    (dependencies.write ?? (value => process.stdout.write(value)))(value);
  };
  let input = null;
  let runtimeConfigPath = null;
  const startedAt = Date.now();
  const readInput = dependencies.readInput ?? readHookInput;
  // The hook's own resolution, kept so a failure is recorded where its data lives.
  const resolveRuntimeOptions = (...resolveArgs) => {
    const options = (dependencies.resolveRuntimeOptions ?? resolveGraphRuntimeOptions)(...resolveArgs);
    runtimeConfigPath = options?.runtimeConfigPath ?? null;
    return options;
  };
  const recovery = (error = null) => consoleRecoveryNotice(runtimeConfigPath
    ?? runtimeConfigPathOf(args, dependencies.env, dependencies.cwd), error);
  const unavailable = (cause, error = null) =>
    `${JSON.stringify(codexLifecycleUnavailable(event, input, cause, '', recovery(error)))}\n`;
  const budget = entryBudget(timeoutMs);
  let cleanup = async () => {};
  let deadline;
  const expired = new Promise(resolve => {
    deadline = setTimeout(async () => {
      controller.abort();
      write(`${JSON.stringify(codexEntryDeadlineOutput(event, input, budget, `no answer within ${timeoutMs} ms`, recovery()))}\n`);
      // A broken dependency must not hold the host open. Give opened leases
      // and connections a bounded chance to close before the process exits.
      const closing = cleanup();
      // The console stays alive and holds the call until onSettled. Its caller
      // needs the already prepared answer before the return trip expires.
      if (dependencies.onSettled) {
        resolve({ timedOut: true });
        return;
      }
      let grace;
      await Promise.race([closing, new Promise(done => { grace = setTimeout(done, 250); })]);
      clearTimeout(grace);
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  try {
    const running = runWithEntryBudget(budget, () => runCodexLifecycleHook(args, { ...dependencies, signal: controller.signal, write,
      resolveRuntimeOptions,
      captureTimeoutMs: Math.max(1, Math.min(750, Math.floor(timeoutMs / 4))),
      readInput: async () => { input = await readInput(); return input; },
      onCleanup: close => { cleanup = close; } })).then(() => ({ timedOut: false }), (error) => {
      // Never print prompts, transcripts, paths or credentials.
      write(unavailable(hookFailureCause(error), error));
      recordHookFailure({ runtimeConfigPath, client: 'codex', event, error, sessionId: input?.session_id, startedAt });
      return { timedOut: false };
    });
    void running.finally(() => dependencies.onSettled?.());
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(deadline);
  }
}

// The #fulidebug recorder's line goes to the caller's stderr, not this process's.
function debugTurnLog({ log }) { return log ? { log } : {}; }

// One installed hook call (lifecycle-events.js): the command line, the
// environment it runs with, its working directory and its stdin chunks, to
// what it prints and its exit code. Nothing here reads this process's argv,
// environment, working directory or stdin, so the console can run many at once.
// It answers by the hook's own deadline (or the shorter timeoutMs left of it);
// at the deadline the work is cancelled and its lease and stores are closed,
// not awaited. onSettled runs once the work has ended.
export async function runCodexLifecycleEvent({ argv, env, cwd, stdin, timeoutMs }, { onSettled } = {}) {
  let stdout = '';
  const stderr = [];
  await runCodexLifecycleCommand([...argv], { env, cwd, timeoutMs, onSettled, write: value => { stdout += value; },
    log: line => { stderr.push(`${line}\n`); }, readInput: () => readHookInput(stdin) });
  return { stdout, stderr: stderr.join(''), exitCode: 0 };
}

// What the hook answers when the console took its call and then failed or
// went silent (lifecycle-forwarder.js): the event may have run there, so it is
// never run again here.
export function codexLifecycleEventLost({ argv, env, cwd, stdin }, error) {
  const args = [...argv];
  const event = args[args.indexOf('--event') + 1];
  let input = null;
  try { input = parseHookInput(Buffer.concat(stdin)); } catch { /* answered without a session */ }
  const runtimeConfigPath = runtimeConfigPathOf(args, env, cwd);
  recordHookFailure({ runtimeConfigPath, client: 'codex', event, error, sessionId: input?.session_id });
  const output = codexLifecycleUnavailable(event, input, hookFailureCause(error), '', consoleRecoveryNotice(runtimeConfigPath));
  return { stdout: `${JSON.stringify(output)}\n`, stderr: '', exitCode: 0 };
}
