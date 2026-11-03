import { spawn } from 'node:child_process';

import { resolveClientCommand } from '../../../packages/roundtable/src/roundtable/wake.js';

// Reads whether Codex trusts FULI's lifecycle hooks by asking Codex's own
// app-server (JSON-RPC over stdio). Codex keeps its trust record in its own
// config.toml and only it can say whether each hook is trusted, so FULI reads
// the answer instead of guessing (src/agents/codex/hook-trust.js). A hook is
// FULI's when its command carries COMMAND_MARKER, the argument FULI's Codex
// hook command always has (src/agent-kits/pack-manifest.js); anything but
// trustStatus "trusted" means not trusted.
const COMMAND_MARKER = '--fuli-lifecycle';
const HOOKS_LIST_TIMEOUT_MS = 10_000;

const INITIALIZE = { id: 1, method: 'initialize', params: { clientInfo: { name: 'fuli', version: '1' },
  capabilities: { experimentalApi: true } } };
const INITIALIZED = { method: 'initialized' };
const HOOKS_LIST = { id: 2, method: 'hooks/list', params: {} };

// One read spawns Codex's CLI, asks hooks/list, kills it, and answers
// { readable: true, untrusted: [eventName...] } for FULI's untrusted hooks, or
// { readable: false, reason } when Codex is missing, times out or errors.
// spawnImpl and resolveCommand are injectable so tests use a fake process,
// never the real Codex.
export function createCodexHookTrustReader({
  spawnImpl = spawn,
  resolveCommand = () => resolveClientCommand('codex'),
  timeoutMs = HOOKS_LIST_TIMEOUT_MS
} = {}) {
  return async function read() {
    try {
      const command = resolveCommand();
      if (!command) return { readable: false, reason: 'codex_missing' };
      return await runHooksList(command, spawnImpl, timeoutMs);
    } catch {
      return { readable: false, reason: 'codex_error' };
    }
  };
}

function runHooksList(command, spawnImpl, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawnImpl(command, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let settled = false;
    let pending = '';
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };

    child.on('error', () => finish({ readable: false, reason: 'codex_error' }));
    child.on('close', () => finish({ readable: false, reason: 'codex_error' }));
    child.stdout.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (response?.id === 2) finish(parseHooksList(response));
      }
    });
    child.stdin.on('error', () => {});
    timer = setTimeout(() => finish({ readable: false, reason: 'codex_timeout' }), timeoutMs);
    for (const message of [INITIALIZE, INITIALIZED, HOOKS_LIST]) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

// hooks/list answers { id: 2, result: { data: [{ cwd, hooks: [{ eventName, command, trustStatus, ... }] }] } }.
// Each data entry names one workspace and its hooks; FULI's hooks are the ones
// whose command carries COMMAND_MARKER. A malformed answer is an error.
function parseHooksList(response) {
  const data = response?.result?.data;
  if (!Array.isArray(data)) return { readable: false, reason: 'codex_error' };
  const untrusted = [];
  for (const entry of data) {
    for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      if (typeof hook?.command === 'string' && hook.command.includes(COMMAND_MARKER) && hook.trustStatus !== 'trusted') {
        untrusted.push(hook.eventName);
      }
    }
  }
  return { readable: true, untrusted };
}
