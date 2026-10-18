#!/usr/bin/env node
import { outdatedMcpNotice, withOutdatedMcpNotice } from '../../mcp/process-registry.js';
import { FULI_VERSION } from '../../package-metadata.js';
import { transcriptLifecycle } from '../../conversations/transcript-lifecycle.js';
import { compactTaskContext } from '../../conversations/task-context-view.js';
import { PREFERENCE_RESET_EVENTS, preferenceHookOutput, preferenceLifecycleOutput } from '../../conversations/preference-lifecycle.js';
import { isSystemPromptEntry, systemPromptOutput } from '../system-prompt.js';
import { normalizeCodexRecord, verifyCodexTranscript } from './conversation-transcript.js';

import { callAgentTool } from '../../agent-tools.js';
import { createRuntimeLeaseClient } from '../../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../../graphiti/runtime-config.js';
import { isMainModule } from '../../system/main-module.js';
import { readHookInput } from '../lifecycle-input.js';
import { stopHookOutcome } from '../../conversations/stop-auto-close.js';

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

export async function codexLifecycleOutput(event, input, invoke, { delivery, currentTask } = {}) {
  if (event === 'UserPromptSubmit' && isSystemPromptEntry(input)) return systemPromptOutput(event);
  if (PREFERENCE_RESET_EVENTS.includes(event)) return preferenceLifecycleOutput(event, input,
    { sourceApplication: 'codex', delivery, currentTask, invoke });
  if (event === 'Stop') return codexStopLifecycleOutput(input, invoke);
  if (!input?.session_id || typeof input.cwd !== 'string' || typeof input.prompt !== 'string') {
    throw new TypeError('Codex task entry requires session, cwd and prompt');
  }
  const context = await invoke('begin_task_context', { sessionId: input.session_id,
    turnId: input.turn_id ?? null, projectPath: input.cwd, taskPrompt: input.prompt.slice(0, 8192),
    sourceApplication: 'codex', sourceSessionId: input.session_id });
  return preferenceHookOutput(compactTaskContext(context), event, input, delivery, 'codex',
    'Fuli task context. Apply effective_preferences. Follow checkpoint_guidance: checkpoint with taskContextToken only when there is something to record; the Stop hook closes the rest. Shared rules are referenced by version; read MCP resource fuli://rules/task-entry when one applies.');
}

export async function runCodexLifecycleHook(args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  if (!['Stop', 'UserPromptSubmit', ...PREFERENCE_RESET_EVENTS].includes(event)) throw new TypeError('Missing Codex lifecycle event');
  const input = await (dependencies.readInput ?? readHookInput)();
  const write = dependencies.write ?? ((value) => process.stdout.write(value));
  if (event === 'UserPromptSubmit' && isSystemPromptEntry(input)) {
    const output = systemPromptOutput(event); write(`${JSON.stringify(output)}\n`); return output;
  }
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
      if (PREFERENCE_RESET_EVENTS.includes(event)) return codexLifecycleOutput(event, input,
        (name, parameters) => invokeTool(app, name, parameters, { signal: dependencies.signal }),
        { delivery: app.preferenceDelivery, currentTask: app.taskContextRegistry?.current?.bind(app.taskContextRegistry) });
      return transcriptLifecycle({ application: app, runtimeConfigPath, input, event, sourceApplication: 'codex',
        captureTimeoutMs: dependencies.captureTimeoutMs, signal: dependencies.signal,
        adapter: { normalize: normalizeCodexRecord, verify: verifyCodexTranscript },
        run: onContext => codexLifecycleOutput(event, input, async (name, parameters) => {
          const context = await invokeTool(app, name, parameters, { signal: dependencies.signal });
          if (name === 'begin_task_context') onContext(context);
          return context;
        }, { delivery: app.preferenceDelivery }) });
    }, { signal: dependencies.signal });
    const delivered = event === 'UserPromptSubmit' ? withOutdatedMcpNotice(output, outdatedMcpNotice(runtimeConfigPath,
      { sourceApplication: 'codex', version: FULI_VERSION, sessionId: input?.session_id })) : output;
    write(`${JSON.stringify(delivered)}\n`);
    return delivered;
  } finally {
    await cleanup();
  }
}

async function closeQuietly(resource) {
  try {
    await resource?.close();
  } catch {
    // Cleanup diagnostics may contain local paths. The lifecycle adapter fails open.
  }
}


function codexLifecycleUnavailable(event, input) {
  const warning = 'Fuli context is unavailable. Continue with the user request; saved context and checkpoint were not verified.';
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
  const configured = Number(args[args.indexOf('--timeout-ms') + 1]);
  const timeoutMs = args.includes('--timeout-ms') && Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 5000) : 5000;
  const controller = new AbortController();
  let emitted = false;
  const write = value => {
    if (emitted) return;
    emitted = true;
    (dependencies.write ?? (value => process.stdout.write(value)))(value);
  };
  let input = null;
  const readInput = dependencies.readInput ?? readHookInput;
  const unavailable = () => `${JSON.stringify(codexLifecycleUnavailable(event, input))}\n`;
  let cleanup = async () => {};
  let deadline;
  const expired = new Promise(resolve => {
    deadline = setTimeout(async () => {
      controller.abort();
      write(unavailable());
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
      write(unavailable());
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
