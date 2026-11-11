import { hookFailureCause, PASS_TASK_TOKEN, TASK_RULES_ON_DEMAND, taskClosingInstruction } from './lifecycle-message.js';
import { consoleRecoveryNotice, recordHookFailure } from './lifecycle-failure.js';
import { compactTaskContext } from '../conversations/task-context-view.js';
import { preferenceHookOutput } from '../conversations/preference-lifecycle.js';
import { sessionFuliCommandResult, sessionFuliEntryRefusal, sessionFuliOffContext } from '../conversations/session-fuli-entry.js';
import { stopHookOutcome } from '../conversations/stop-auto-close.js';
import { entryBudget, NO_TASK_AT_DEADLINE, partialEntryText, runWithEntryBudget } from '../conversations/entry-budget.js';
import { taskSceneInput } from '../graphiti/task-scene.js';
import { callAgentTool } from '../agent-tools.js';
import { createRuntimeLeaseClient } from '../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../graphiti/runtime-config.js';
import { platformPath, wslCallerPath } from '../system/platform-path.js';
import { readHookInput } from './lifecycle-input.js';

// The FULI side of a client plugin that runs inside the client's own process
// (OpenCode V2, DeepSeek Harness): the plugin (plugin-hook-process.js) starts
// the client's lifecycle-hook.js with FULI's Node for each event, as the
// Claude Code and Codex hooks are started, and that script calls this module
// with its client. Input is the plugin's JSON on stdin; the answer is one
// JSON line: `{ context }` for a prompt (model-visible text for that turn),
// `{}` for a stop.
//
// client: { id, name, sourceApplication }. `id` names failures in the
// diagnostics log; `sourceApplication` is the client's own source, which its
// MCP entry runs as too, so a hook task and the model's MCP calls share one
// session namespace.
const PLUGIN_EVENTS = Object.freeze(['prompt', 'stop']);
const STOP_TIMEOUT_MS = 5_000;
// As Codex's entry (codex/lifecycle-hook.js): a cold first entry runs past 5 s.
const DEFAULT_PROMPT_TIMEOUT_MS = 15_000;

const entryLabel = (client) => `Fuli task context (${client.name} plugin). Apply effective_preferences. `;

// pathApi: the path rules of the host FULI runs on.
export async function pluginLifecycleOutput(client, event, input, invoke, { command: sessionCommand, entryRefusal,
  pathApi = platformPath() } = {}) {
  if (!PLUGIN_EVENTS.includes(event)) throw new TypeError(`Unsupported ${client.name} lifecycle event`);
  const sessionId = input?.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) {
    throw new TypeError(`${client.name} hook requires a host session identifier`);
  }
  const source = { sourceApplication: client.sourceApplication, sourceSessionId: sessionId };
  if (event === 'stop') {
    // The end of a successful execution, as a Stop hook: a hook-delivered
    // task with no checkpoint is closed honestly; nothing forces another turn.
    // Neither client shows a message after a turn, so a reminder is not returned.
    const check = await invoke('verify_task_checkpoint', { sessionId, ...source });
    await stopHookOutcome(check, invoke, source);
    return {};
  }
  if (typeof input.cwd !== 'string' || !input.cwd.trim() || typeof input.prompt !== 'string') {
    throw new TypeError(`${client.name} task entry requires cwd and prompt`);
  }
  const projectPath = wslCallerPath(input.cwd, input.wsl_distribution, pathApi);
  // A plugin cannot hold a prompt back, so the person's FULI
  // command line still reaches the model: it is told the answer to relay.
  const command = await sessionCommand?.({ sessionId, sourceApplication: client.sourceApplication, prompt: input.prompt,
    projectPath });
  if (command) {
    return { context: `The person's message is a FULI session command; FULI already applied it and answered: `
      + `${JSON.stringify(`FULI: ${command.message}`)}. Reply with that answer only; no task was started.` };
  }
  const off = await entryRefusal?.();
  if (off) return { context: sessionFuliOffContext(off) };
  const context = await invoke('begin_task_context', { sessionId,
    ...(typeof input.message_id === 'string' ? { turnId: input.message_id } : {}),
    projectPath, taskPrompt: input.prompt.slice(0, 8192), ...source, ...taskSceneInput(input.prompt) });
  const entry = compactTaskContext(context);
  const output = await preferenceHookOutput(entry, 'UserPromptSubmit', input, null, client.sourceApplication,
    entryLabel(client) + taskClosingInstruction(entry) + PASS_TASK_TOKEN + TASK_RULES_ON_DEMAND);
  return { context: output.hookSpecificOutput.additionalContext };
}

export async function runPluginLifecycleHook(client, args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  if (!PLUGIN_EVENTS.includes(event)) throw new TypeError(`Missing ${client.name} lifecycle event`);
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
    return await leases.withGraphLease(`${client.id}-lifecycle`, () => pluginLifecycleOutput(client, event, input,
      (name, parameters) => invokeTool(app, name, parameters, { signal: dependencies.signal }), {
        command: request => sessionFuliCommandResult(app, request),
        entryRefusal: () => sessionFuliEntryRefusal(app, { sessionId: input.session_id, sourceApplication: client.sourceApplication })
      }), { signal: dependencies.signal });
  } finally {
    await cleanup();
  }
}

// One line, so the plugin adds no more than that when FULI cannot answer.
function unavailableContext(cause) {
  return `Fuli context is unavailable (${cause}). Continue with the user request; FULI memory and preferences were not loaded for this turn.`;
}

function hookTimeoutMs(args) {
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
  return { context: partialEntryText(budget) ?? `${unavailableContext(cause)}${NO_TASK_AT_DEADLINE}` };
}

// The process entry: always answers one JSON line within its deadline and
// never prints prompts, paths or exception text.
export async function runPluginLifecycleCommand(client, args, dependencies = {}) {
  const event = args[args.indexOf('--event') + 1];
  const timeoutMs = hookTimeoutMs(args);
  const controller = new AbortController();
  let emitted = false;
  const write = (output) => {
    if (emitted) return;
    emitted = true;
    (dependencies.write ?? (value => process.stdout.write(value)))(`${JSON.stringify(output)}\n`);
  };
  const budget = entryBudget(timeoutMs);
  const startedAt = Date.now();
  let runtimeConfigPath = null;
  let sessionId = null;
  const readInput = dependencies.readInput ?? readHookInput;
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
    const running = runWithEntryBudget(budget, () => runPluginLifecycleHook(client, args, { ...dependencies,
      readInput: async () => { const input = await readInput(); sessionId = input?.session_id ?? null; return input; },
      // The hook's own resolution, kept so a failure is recorded where its data lives.
      resolveRuntimeOptions: (...resolveArgs) => {
        const options = (dependencies.resolveRuntimeOptions ?? resolveGraphRuntimeOptions)(...resolveArgs);
        runtimeConfigPath = options?.runtimeConfigPath ?? null;
        return options;
      },
      signal: controller.signal, onCleanup: close => { cleanup = close; } }))
      .then(output => { write(output); return { timedOut: false }; },
        (error) => {
          write(event === 'prompt' ? { context: unavailableContext(hookFailureCause(error))
            + consoleRecoveryNotice(runtimeConfigPath) } : {});
          recordHookFailure({ runtimeConfigPath, client: client.id, event, error, sessionId, startedAt });
          return { timedOut: false };
        });
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
