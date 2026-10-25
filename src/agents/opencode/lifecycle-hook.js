#!/usr/bin/env node
import { PASS_TASK_TOKEN, TASK_RULES_ON_DEMAND, taskClosingInstruction } from '../lifecycle-message.js';
import { compactTaskContext } from '../../conversations/task-context-view.js';
import { preferenceHookOutput } from '../../conversations/preference-lifecycle.js';
import { sessionFuliCommandResult, sessionFuliEntryRefusal, sessionFuliOffContext } from '../../conversations/session-fuli-entry.js';
import { stopHookOutcome } from '../../conversations/stop-auto-close.js';
import { entryBudget, NO_TASK_AT_DEADLINE, partialEntryText, runWithEntryBudget } from '../../conversations/entry-budget.js';
import { taskSceneInput } from '../../graphiti/task-scene.js';
import { callAgentTool } from '../../agent-tools.js';
import { createRuntimeLeaseClient } from '../../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../../graphiti/runtime-config.js';
import { isMainModule } from '../../system/main-module.js';
import { readHookInput } from '../lifecycle-input.js';

// The FULI side of the OpenCode V2 plugin (plugin.js): OpenCode runs plugins
// inside its own Bun process, so the plugin starts this script with FULI's
// Node for each event, as the Claude Code and Codex hooks are started. Input
// is the plugin's JSON on stdin; the answer is one JSON line: `{ context }`
// for a prompt (system text for that turn's model requests), `{}` for a stop.
const OPENCODE_EVENTS = Object.freeze(['prompt', 'stop']);

// OpenCode's own source application (rec#11 D-64); its MCP entry runs as
// `opencode` too, so a hook task and the model's MCP calls share one session
// namespace that no other `other` client shares.
const SOURCE_APPLICATION = 'opencode';
const STOP_TIMEOUT_MS = 5_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 10_000;

const ENTRY_LABEL = 'Fuli task context (OpenCode plugin). Apply effective_preferences. ';

export async function openCodeLifecycleOutput(event, input, invoke, session = {}) {
  if (!OPENCODE_EVENTS.includes(event)) throw new TypeError('Unsupported OpenCode lifecycle event');
  const sessionId = input?.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) {
    throw new TypeError('OpenCode hook requires a host session identifier');
  }
  const source = { sourceApplication: SOURCE_APPLICATION, sourceSessionId: sessionId };
  if (event === 'stop') {
    // The end of a successful execution, as a Stop hook: a hook-delivered
    // task with no checkpoint is closed honestly; nothing forces another turn.
    // OpenCode shows no message after a turn, so a reminder is not returned.
    const check = await invoke('verify_task_checkpoint', { sessionId, ...source });
    await stopHookOutcome(check, invoke, source);
    return {};
  }
  if (typeof input.cwd !== 'string' || !input.cwd.trim() || typeof input.prompt !== 'string') {
    throw new TypeError('OpenCode task entry requires cwd and prompt');
  }
  // OpenCode's prompt hook cannot hold a prompt back, so the person's FULI
  // command line still reaches the model: it is told the answer to relay.
  const command = await session.command?.({ sessionId, sourceApplication: SOURCE_APPLICATION, prompt: input.prompt,
    projectPath: input.cwd });
  if (command) {
    return { context: `The person's message is a FULI session command; FULI already applied it and answered: `
      + `${JSON.stringify(`FULI: ${command.message}`)}. Reply with that answer only; no task was started.` };
  }
  const off = await session.entryRefusal?.();
  if (off) return { context: sessionFuliOffContext(off) };
  const context = await invoke('begin_task_context', { sessionId,
    ...(typeof input.message_id === 'string' ? { turnId: input.message_id } : {}),
    projectPath: input.cwd, taskPrompt: input.prompt.slice(0, 8192), ...source, ...taskSceneInput(input.prompt) });
  const entry = compactTaskContext(context);
  const output = await preferenceHookOutput(entry, 'UserPromptSubmit', input, null, SOURCE_APPLICATION,
    ENTRY_LABEL + taskClosingInstruction(entry) + PASS_TASK_TOKEN + TASK_RULES_ON_DEMAND);
  return { context: output.hookSpecificOutput.additionalContext };
}

export async function runOpenCodeLifecycleHook(args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  if (!OPENCODE_EVENTS.includes(event)) throw new TypeError('Missing OpenCode lifecycle event');
  const input = await (dependencies.readInput ?? readHookInput)();
  const { runtimeConfigPath } = (dependencies.resolveRuntimeOptions ?? resolveGraphRuntimeOptions)(
    args, dependencies.env ?? process.env);
  let app;
  let leases;
  let closing;
  const cleanup = () => closing ??= Promise.allSettled([closeQuietly(leases), closeQuietly(app)]);
  dependencies.onCleanup?.(cleanup);
  try {
    app = (dependencies.openApplication ?? openFederatedGraphApplication)({ runtimeConfigPath });
    leases = (dependencies.createLeases ?? createRuntimeLeaseClient)({ runtimeConfigPath });
    const invokeTool = dependencies.callTool ?? callAgentTool;
    return await leases.withGraphLease('opencode-lifecycle', () => openCodeLifecycleOutput(event, input,
      (name, parameters) => invokeTool(app, name, parameters, { signal: dependencies.signal }), {
        command: request => sessionFuliCommandResult(app, request),
        entryRefusal: () => sessionFuliEntryRefusal(app, { sessionId: input.session_id, sourceApplication: SOURCE_APPLICATION })
      }), { signal: dependencies.signal });
  } finally {
    await cleanup();
  }
}

// One line, so the plugin adds no more than that when FULI cannot answer.
function openCodeUnavailableContext(cause) {
  return `Fuli context is unavailable (${cause}). Continue with the user request; FULI memory and preferences were not loaded for this turn.`;
}

function openCodeHookTimeoutMs(args) {
  const event = args[args.indexOf('--event') + 1];
  const limit = event === 'prompt' ? DEFAULT_PROMPT_TIMEOUT_MS : STOP_TIMEOUT_MS;
  const configured = Number(args[args.indexOf('--timeout-ms') + 1]);
  return args.includes('--timeout-ms') && Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, limit) : limit;
}

// At the deadline an entry that already wrote its task delivers its token and
// what is missing (entry-budget.js); otherwise one line says FULI did not answer.
function deadlineOutput(event, budget, cause) {
  if (event !== 'prompt') return {};
  return { context: partialEntryText(budget) ?? `${openCodeUnavailableContext(cause)}${NO_TASK_AT_DEADLINE}` };
}

// The process entry: always answers one JSON line within its deadline and
// never prints prompts, paths or exception text.
export async function runOpenCodeLifecycleCommand(args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  const timeoutMs = openCodeHookTimeoutMs(args);
  const controller = new AbortController();
  let emitted = false;
  const write = (output) => {
    if (emitted) return;
    emitted = true;
    (dependencies.write ?? (value => process.stdout.write(value)))(`${JSON.stringify(output)}\n`);
  };
  const budget = entryBudget(timeoutMs);
  let cleanup = async () => {};
  let deadline;
  const expired = new Promise(resolve => {
    deadline = setTimeout(async () => {
      controller.abort();
      write(deadlineOutput(event, budget, `no answer within ${timeoutMs} ms`));
      let grace;
      await Promise.race([cleanup(), new Promise(done => { grace = setTimeout(done, 250); })]);
      clearTimeout(grace);
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  try {
    const running = runWithEntryBudget(budget, () => runOpenCodeLifecycleHook(args, { ...dependencies,
      signal: controller.signal, onCleanup: close => { cleanup = close; } }))
      .then(output => { write(output); return { timedOut: false }; },
        () => { write(event === 'prompt' ? { context: openCodeUnavailableContext('the hook failed') } : {}); return { timedOut: false }; });
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(deadline);
  }
}

async function closeQuietly(resource) {
  try {
    await resource?.close();
  } catch {
    // Cleanup diagnostics may contain local paths. The lifecycle adapter fails open.
  }
}

// The answer is the process's whole job: it exits once the line is flushed,
// so a detached close never lingers on an open handle.
if (isMainModule(import.meta.url)) {
  await runOpenCodeLifecycleCommand(process.argv.slice(2));
  process.stdout.write('', () => process.exit(0));
}
