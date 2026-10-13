#!/usr/bin/env node
import { withTranscriptGuard } from '../../conversations/transcript-guard.js';
import { guidanceDirectoryFor, hookTaskContextOutput } from '../../conversations/hook-task-context.js';
import { syncConversationTranscript, withTranscriptNotice, claimTranscriptBoundary, recordTranscriptTaskEntry } from '../../conversations/sync-transcript.js';
import { normalizeClaudeRecord, verifyClaudeTranscript } from './conversation-transcript.js';

import { callAgentTool } from '../../agent-tools.js';
import { createRuntimeLeaseClient } from '../../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../../graphiti/runtime-config.js';
import { isMainModule } from '../../system/main-module.js';
import { boundedHookMessage } from '../lifecycle-message.js';

export async function claudeLifecycleOutput(event, input, invoke, { guidanceDirectory = null } = {}) {
  if (!['UserPromptSubmit', 'Stop'].includes(event)) throw new TypeError('Unsupported Claude lifecycle event');
  const sessionId = input?.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) {
    throw new TypeError('Claude lifecycle requires a host session identifier');
  }
  const source = { sourceApplication: 'claude_code', sourceSessionId: sessionId };
  if (event === 'UserPromptSubmit') {
    if (typeof input.cwd !== 'string' || !input.cwd.trim() || typeof input.prompt !== 'string') {
      throw new TypeError('Claude task entry requires cwd and prompt');
    }
    const context = await invoke('begin_task_context', {
      sessionId, projectPath: input.cwd, taskPrompt: input.prompt.slice(0, 8192), ...source
    });
    return hookTaskContextOutput(context, {
      hookEventName: event,
      label: 'Fuli task context. Read full context; apply effective_preferences. Finish with checkpoint_task_knowledge and a truthful workLog.',
      guidanceDirectory
    });
  }
  const check = await invoke('verify_task_checkpoint', { sessionId, ...source });
  const reason = boundedHookMessage(check?.reason);
  if (check?.decision !== 'block' || !reason.trim()) return {};
  return { systemMessage: reason };
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
    return await leases.withGraphLease('claude-code-lifecycle', async () => {
      try {
        if (app.getCapturePolicy?.().enabled && input.transcript_path) dependencies.onTranscriptGuard?.();
        return await withTranscriptGuard(runtimeConfigPath, input, 'claude_code', app.getCapturePolicy?.().enabled, async guard => {
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
          }, { guidanceDirectory: guidanceDirectoryFor(runtimeConfigPath) });
          if (event === 'UserPromptSubmit') sync = await claimTranscriptBoundary(app, input, 'claude_code', sync, {
            normalize: normalizeClaudeRecord, verify: verifyClaudeTranscript
          }, entryGuard);
          if (event === 'UserPromptSubmit' && sync.entryBlocked) return claudeLifecycleUnavailable(event, input, boundedHookMessage(sync.reason));
          return withTranscriptNotice(output, sync);
        });
      } catch (error) {
        if (event !== 'UserPromptSubmit' || !app.getCapturePolicy?.().enabled || !input.transcript_path) throw error;
        return claudeLifecycleUnavailable(event, input, error.code === 'EADDRINUSE'
          ? 'The session handoff lock is occupied. Retry after the current hook finishes; if it persists, start a new host session and resume the intended Agent.'
          : 'Fuli transcript handoff could not be completed safely. Retry task entry; no previous Agent context was supplied.');
      }
    }, request);
  } finally {
    await Promise.allSettled([close(leases), close(app)]);
  }
}

async function close(resource) { await resource?.close(); }

async function readHookInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 256 * 1024) throw new TypeError('Hook input exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

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
