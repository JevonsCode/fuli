#!/usr/bin/env node
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
        sourceApplication: 'codex',
        sourceSessionId: sessionId
      });
    }
    return {};
  }
  return { decision: 'block', reason: boundedHookMessage(check.reason) };
}

export async function runCodexLifecycleHook(args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  if (event !== 'Stop') throw new TypeError('Missing Codex lifecycle event');
  const input = await (dependencies.readInput ?? readHookInput)();
  const write = dependencies.write ?? ((value) => process.stdout.write(value));
  if (dependencies.invoke) {
    const output = await codexStopLifecycleOutput(input, dependencies.invoke);
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
    const output = await leases.withGraphLease('codex-lifecycle', () =>
      codexStopLifecycleOutput(
        input,
        (name, parameters) => invokeTool(app, name, parameters)
      )
    );
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
