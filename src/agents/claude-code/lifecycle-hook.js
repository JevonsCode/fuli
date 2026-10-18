#!/usr/bin/env node
import { transcriptGuardFailureMessage, withTranscriptGuard } from '../../conversations/transcript-guard.js';
import { compactTaskContext } from '../../conversations/task-context-view.js';
import { PREFERENCE_RESET_EVENTS, preferenceHookOutput, preferenceLifecycleOutput } from '../../conversations/preference-lifecycle.js';
import { syncConversationTranscript, withTranscriptNotice, claimTranscriptBoundary, recordTranscriptTaskEntry } from '../../conversations/sync-transcript.js';
import { normalizeClaudeRecord, verifyClaudeTranscript } from './conversation-transcript.js';
import { hostNotificationOutput, isHostNotificationEntry } from './host-notification.js';

import { callAgentTool } from '../../agent-tools.js';
import { createRuntimeLeaseClient } from '../../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../../graphiti/runtime-config.js';
import { isMainModule } from '../../system/main-module.js';
import { readHookInput } from '../lifecycle-input.js';
import { boundedHookMessage } from '../lifecycle-message.js';
import { stopHookOutcome } from '../../conversations/stop-auto-close.js';
import { outdatedMcpNotice, withOutdatedMcpNotice } from '../../mcp/process-registry.js';
import { FULI_VERSION } from '../../package-metadata.js';

export async function claudeLifecycleOutput(event, input, invoke, { delivery, currentTask } = {}) {
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
    if (isHostNotificationEntry(input)) return hostNotificationOutput(event);
    const context = await invoke('begin_task_context', {
      sessionId, projectPath: input.cwd, taskPrompt: input.prompt.slice(0, 8192), ...source
    });
    return preferenceHookOutput(compactTaskContext(context), event, input, delivery, 'claude_code',
      'Fuli task context. Read full context; apply effective_preferences. Follow checkpoint_guidance: checkpoint_task_knowledge only when there is something to record; the Stop hook closes the rest. Shared rules are referenced by version; read MCP resource fuli://rules/task-entry when one applies.');
  }
  const check = await invoke('verify_task_checkpoint', { sessionId, ...source });
  return stopHookOutcome(check, invoke, source);
}

export function claudeLifecycleUnavailable(event, input = null, reason = null) {
  const warning = reason ?? 'Fuli context is unavailable; memory recovery and task checkpoint are not verified. '
    + 'Continue with the user request and use Fuli MCP when it becomes available.';
  const sessionId = input?.session_id;
  const fallback = typeof sessionId === 'string' && sessionId.trim() && sessionId.length <= 256
    ? ` No valid Hook task context was supplied. First call get_collaboration_preferences with sessionId=${JSON.stringify(sessionId)}, projectPath=current working directory and taskPrompt=current user request. Use its fresh taskContextToken for checkpoint_task_knowledge with a truthful workLog. Native transcript capture remains unverified; do not reuse an old token or claim this Hook delivered task context.`
    : '';
  return event === 'UserPromptSubmit'
    ? { systemMessage: warning, hookSpecificOutput: { hookEventName: event, additionalContext: warning + fallback } }
    : { systemMessage: warning };
}

export async function runClaudeLifecycleHook(args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  const input = await (dependencies.readInput ?? readHookInput)();
  if (event === 'UserPromptSubmit' && isHostNotificationEntry(input)) return hostNotificationOutput(event);
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
    const output = await leases.withGraphLease('claude-code-lifecycle', async () => {
      if (PREFERENCE_RESET_EVENTS.includes(event)) return claudeLifecycleOutput(event, input,
        (name, parameters) => (dependencies.callTool ?? callAgentTool)(app, name, parameters, request),
        { delivery: app.preferenceDelivery, currentTask: app.taskContextRegistry?.current?.bind(app.taskContextRegistry) });
      try {
        if (app.getCapturePolicy?.('claude_code').enabled && input.transcript_path) dependencies.onTranscriptGuard?.();
        return await withTranscriptGuard(runtimeConfigPath, input, 'claude_code', app.getCapturePolicy?.('claude_code').enabled, async guard => {
          let sync = await syncConversationTranscript(app, input, 'claude_code', {
            normalize: normalizeClaudeRecord, verify: verifyClaudeTranscript
          }, guard);
          if (event === 'UserPromptSubmit' && sync.entryBlocked) return claudeLifecycleUnavailable(event, input, boundedHookMessage(sync.reason));
          const entryGuard = sync.status === 'capture_disabled' ? null : guard;
          if (event === 'UserPromptSubmit' && entryGuard?.value) await entryGuard.write({ ...entryGuard.value, phase: 'beginning' });
          const output = await claudeLifecycleOutput(event, input, async (name, parameters) => {
            const context = await (dependencies.callTool ?? callAgentTool)(app, name, parameters, request);
            if (name === 'begin_task_context') await recordTranscriptTaskEntry(entryGuard, context);
            return context;
          }, { delivery: app.preferenceDelivery });
          if (event === 'UserPromptSubmit') sync = await claimTranscriptBoundary(app, input, 'claude_code', sync, {
            normalize: normalizeClaudeRecord, verify: verifyClaudeTranscript
          }, entryGuard);
          if (event === 'UserPromptSubmit' && sync.entryBlocked) return claudeLifecycleUnavailable(event, input, boundedHookMessage(sync.reason));
          return withTranscriptNotice(output, sync);
        });
      } catch (error) {
        if (event !== 'UserPromptSubmit' || !app.getCapturePolicy?.('claude_code').enabled || !input.transcript_path) throw error;
        return claudeLifecycleUnavailable(event, input, transcriptGuardFailureMessage(error));
      }
    }, request);
    return event === 'UserPromptSubmit' ? withOutdatedMcpNotice(output, outdatedMcpNotice(runtimeConfigPath,
      { sourceApplication: 'claude_code', version: FULI_VERSION, sessionId: input.session_id })) : output;
  } finally {
    await Promise.allSettled([close(leases), close(app)]);
  }
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
