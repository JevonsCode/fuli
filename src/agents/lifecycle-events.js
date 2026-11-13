import { CLAUDE_HOOK_ENV } from './claude-code/hook-contract.js';
import { CODEX_HOOK_ENV } from './codex/hook-contract.js';

// One installed lifecycle hook call, run either in the hook's own process
// (lifecycle-forwarder.js falls back to it) or by the console for a thin hook
// entry (http/lifecycle-hooks-api-router.js). Each client's work is loaded on
// first use, so a hook process loads only its own client.
//   request: { client, argv, env, cwd, stdin } → { stdout, stderr, exitCode }
// env holds only the client's named hook variables (hook-contract.js);
// baseEnv is the environment of the process running the call, which supplies
// every other variable. stdin is the hook's stdin as Buffer chunks (an array,
// or a stream in the hook's own process).
const CLIENTS = Object.freeze({
  'claude-code': Object.freeze({
    envNames: CLAUDE_HOOK_ENV,
    load: async () => {
      const { runClaudeLifecycleEvent, claudeLifecycleEventLost } = await import('./claude-code/lifecycle-event.js');
      return { run: runClaudeLifecycleEvent, lost: claudeLifecycleEventLost };
    }
  }),
  codex: Object.freeze({
    envNames: CODEX_HOOK_ENV,
    load: async () => {
      const { runCodexLifecycleEvent, codexLifecycleEventLost } = await import('./codex/lifecycle-event.js');
      return { run: runCodexLifecycleEvent, lost: codexLifecycleEventLost };
    }
  })
});

export function lifecycleHookClient(client) {
  return Object.hasOwn(CLIENTS, client) ? CLIENTS[client] : null;
}

export async function runLifecycleEvent(request, { baseEnv }) {
  const { client, adapter } = await clientAdapter(request.client);
  return adapter.run(callFor(request, client, baseEnv));
}

// The hook's answer when its forwarded call may have run and was lost
// (lifecycle-forwarder.js): never a second run.
export async function lostLifecycleEvent(request, error, { baseEnv }) {
  const { client, adapter } = await clientAdapter(request.client);
  return adapter.lost(callFor(request, client, baseEnv), error);
}

async function clientAdapter(id) {
  const client = lifecycleHookClient(id);
  if (!client) throw new TypeError('Unknown lifecycle hook client');
  return { client, adapter: await client.load() };
}

function callFor({ argv, env, cwd, stdin }, client, baseEnv) {
  return { argv, env: hookEnvironment(baseEnv, env, client.envNames), cwd, stdin };
}

// The hook's named variables exactly as the hook process had them (set or
// absent) over the running process's own environment. In the hook's own
// process they already agree, and its environment is used as it is (on
// Windows process.env reads names case-insensitively; a copy does not).
function hookEnvironment(baseEnv, hookEnv, names) {
  if (names.every(name => baseEnv[name] === (typeof hookEnv?.[name] === 'string' ? hookEnv[name] : undefined))) {
    return baseEnv;
  }
  const environment = { ...baseEnv };
  for (const name of names) {
    delete environment[name];
    if (typeof hookEnv?.[name] === 'string') environment[name] = hookEnv[name];
  }
  return environment;
}
