#!/usr/bin/env node
import { withTranscriptGuard } from '../../conversations/transcript-guard.js';
import { compactTaskContext } from '../../conversations/task-context-view.js';
import { syncConversationTranscript, withTranscriptNotice, claimTranscriptBoundary, recordTranscriptTaskEntry } from '../../conversations/sync-transcript.js';
import { normalizeCodexRecord, verifyCodexTranscript } from './conversation-transcript.js';
import { hookAdditionalContextToolResult } from '../../mcp/tool-result.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { callAgentTool } from '../../agent-tools.js';
import { createRuntimeLeaseClient } from '../../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../../graphiti/runtime-config.js';
import { boundedHookMessage } from '../lifecycle-message.js';

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
  if (check?.decision !== 'block' || typeof check.reason !== 'string' || !check.reason.trim()) {
    return {};
  }
  if (input.stop_hook_active === true) {
    if (typeof check.task_context_token === 'string' && check.task_context_token.trim()) {
      await invoke('checkpoint_task_knowledge', {
        taskContextToken: check.task_context_token,
        disposition: 'retain_nothing',
        reason: 'Codex Stop hook fallback after one checkpoint continuation.',
        workLog: { status: 'incomplete', summary: 'The host stopped before the employee submitted a work summary. Review the prior task before resuming.' },
        sourceApplication: 'codex',
        sourceSessionId: sessionId
      });
    }
    return {};
  }
  return { decision: 'block', reason: boundedHookMessage(check.reason) };
}

export async function codexLifecycleOutput(event, input, invoke) {
  if (event === 'Stop') return codexStopLifecycleOutput(input, invoke);
  if (!input?.session_id || typeof input.cwd !== 'string' || typeof input.prompt !== 'string') {
    throw new TypeError('Codex task entry requires session, cwd and prompt');
  }
  const context = await invoke('begin_task_context', { sessionId: input.session_id,
    turnId: input.turn_id ?? null, projectPath: input.cwd, taskPrompt: input.prompt.slice(0, 8192),
    sourceApplication: 'codex', sourceSessionId: input.session_id });
  return JSON.parse(hookAdditionalContextToolResult(compactTaskContext(context), { hookEventName: event,
    label: 'Fuli task context. Apply effective_preferences and checkpoint with taskContextToken.',
    limitBytes: 128 * 1024, itemLimit: 1000 }).content[0].text);
}

export async function runCodexLifecycleHook(args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  if (!['Stop', 'UserPromptSubmit'].includes(event)) throw new TypeError('Missing Codex lifecycle event');
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
  let app;
  let leases;
  try {
    app = (dependencies.openApplication ?? openFederatedGraphApplication)({
      runtimeConfigPath
    });
    leases = (dependencies.createLeases ?? createRuntimeLeaseClient)({
      runtimeConfigPath
    });
    const invokeTool = dependencies.callTool ?? callAgentTool;
    const output = await leases.withGraphLease('codex-lifecycle', async () => {
      try {
        return await withTranscriptGuard(runtimeConfigPath, input, 'codex', app.getCapturePolicy?.().enabled, async guard => {
          let sync = await syncConversationTranscript(app, input, 'codex', {
            normalize: normalizeCodexRecord, verify: verifyCodexTranscript
          }, guard);
          if (event === 'UserPromptSubmit' && sync.entryBlocked) return { decision: 'block', reason: sync.reason };
          const entryGuard = sync.status === 'capture_disabled' ? null : guard;
          if (event === 'UserPromptSubmit' && entryGuard?.value) await entryGuard.write({ ...entryGuard.value, phase: 'beginning' });
          const result = await codexLifecycleOutput(event, input, async (name, parameters) => {
            const context = await invokeTool(app, name, parameters);
            if (name === 'begin_task_context') await recordTranscriptTaskEntry(entryGuard, context);
            return context;
          });
          if (event === 'UserPromptSubmit') sync = await claimTranscriptBoundary(app, input, 'codex', sync, {
            normalize: normalizeCodexRecord, verify: verifyCodexTranscript
          }, entryGuard);
          if (event === 'UserPromptSubmit' && sync.entryBlocked) return { decision: 'block', reason: sync.reason };
          return withTranscriptNotice(result, sync);
        });
      } catch (error) {
        if (event !== 'UserPromptSubmit' || !app.getCapturePolicy?.().enabled || !input.transcript_path) throw error;
        return { decision: 'block', reason: error.code === 'EADDRINUSE'
          ? 'The session handoff lock is occupied. Retry after the current hook finishes; if it persists, start a new host session and resume the intended Agent.'
          : 'Fuli transcript handoff could not be completed safely. Retry task entry; no previous Agent context was supplied.' };
      }
    });
    write(`${JSON.stringify(output)}\n`);
    return output;
  } finally {
    await closeQuietly(leases);
    await closeQuietly(app);
  }
}

async function closeQuietly(resource) {
  try {
    await resource?.close();
  } catch {
    // Cleanup diagnostics may contain local paths. The lifecycle adapter fails open.
  }
}

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
  try {
    await runCodexLifecycleHook(process.argv.slice(2));
  } catch {
    // Fail open without printing prompts, transcripts, paths or credentials.
    process.stdout.write('{}\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
