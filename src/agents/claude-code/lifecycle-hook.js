#!/usr/bin/env node
import { PASS_TASK_TOKEN, TASK_RULES_ON_DEMAND } from '../lifecycle-message.js';
import { transcriptLifecycle } from '../../conversations/transcript-lifecycle.js';
import { transcriptCaptureScope } from '../../conversations/sync-transcript.js';
import { captureDecision, withCaptureLookups } from '../../graphiti/capture-decision.js';
import { compactTaskContext } from '../../conversations/task-context-view.js';
import { PREFERENCE_RESET_EVENTS, preferenceHookOutput, preferenceLifecycleOutput } from '../../conversations/preference-lifecycle.js';
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

export async function claudeLifecycleOutput(event, input, invoke, { delivery, currentTask, entryRefusal } = {}) {
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
    // Every prompt enters, including ones shaped like host notifications: neither the hook
    // input nor the transcript written so far proves that the host started this turn (rec#15).
    // A session FULI is off for (rec#5 C3b) gets no task entry.
    const off = await entryRefusal?.();
    if (off) return { hookSpecificOutput: { hookEventName: event, additionalContext: sessionFuliOffContext(off) } };
    const context = await invoke('begin_task_context', {
      sessionId, projectPath: input.cwd, taskPrompt: input.prompt.slice(0, 8192), ...source
    });
    return preferenceHookOutput(compactTaskContext(context), event, input, delivery, 'claude_code',
      'Fuli task context. Read full context; apply effective_preferences. Follow checkpoint_guidance: checkpoint_task_knowledge only when there is something to record; the Stop hook closes the rest. ' + PASS_TASK_TOKEN + TASK_RULES_ON_DEMAND);
  }
  const check = await invoke('verify_task_checkpoint', { sessionId, ...source });
  return stopHookOutcome(check, invoke, source);
}

export function claudeLifecycleUnavailable(event, input = null, reason = null) {
  const warning = reason ?? 'Fuli context is unavailable; memory recovery and task checkpoint are not verified. '
    + 'Continue with the user request and use Fuli MCP when it becomes available.';
  const sessionId = input?.session_id;
  const fallback = typeof sessionId === 'string' && sessionId.trim() && sessionId.length <= 256
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
      if (PREFERENCE_RESET_EVENTS.includes(event)) return claudeLifecycleOutput(event, input,
        (name, parameters) => (dependencies.callTool ?? callAgentTool)(app, name, parameters, request),
        { delivery: app.preferenceDelivery, currentTask: app.taskContextRegistry?.current?.bind(app.taskContextRegistry) });
      if (input.transcript_path && (await captureDecision(app, transcriptCaptureScope(input, 'claude_code'))).allowed) {
        dependencies.onTranscriptGuard?.();
      }
      return transcriptLifecycle({ application: app, runtimeConfigPath, input, event, sourceApplication: 'claude_code',
        captureTimeoutMs: dependencies.captureTimeoutMs, signal: dependencies.signal,
        adapter: { normalize: normalizeClaudeRecord, verify: verifyClaudeTranscript },
        run: onContext => claudeLifecycleOutput(event, input, async (name, parameters) => {
          const context = await (dependencies.callTool ?? callAgentTool)(app, name, parameters, request);
          if (name === 'begin_task_context') onContext(context);
          return context;
        }, { delivery: app.preferenceDelivery, entryRefusal: () => sessionFuliEntryRefusal(app,
          { sessionId: input.session_id, sourceApplication: 'claude_code' }) }) });
    }), request);
    return event === 'UserPromptSubmit' ? withOutdatedMcpNotice(output, outdatedMcpNotice(runtimeConfigPath,
      { sourceApplication: 'claude_code', version: FULI_VERSION, sessionId: input.session_id })) : output;
  } finally {
    await Promise.allSettled([close(leases), close(app)]);
  }
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
