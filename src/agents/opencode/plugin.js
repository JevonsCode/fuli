import { spawn } from 'node:child_process';
import { join } from 'node:path';

// The OpenCode V2 server plugin (rec#11 D-63). OpenCode loads it inside its
// own Bun process through the file FULI setup writes into OpenCode's plugins
// directory (plugin-file.js), so this module imports Node built-ins only.
// Each event starts FULI's lifecycle hook (lifecycle-hook.js) with FULI's
// Node, as the Claude Code and Codex hooks are started:
// - `prompt` (session.hook "prompt", at prompt admission) begins the task and
//   keeps its entry; the person's prompt text is never changed;
// - `context` (before each model request of that turn, not persisted) adds the
//   entry as system text;
// - `session.execution.succeeded` closes the task as a Stop hook does. A
//   failed or interrupted execution closes nothing, as an interrupted Claude
//   Code or Codex turn runs no Stop hook; its task stays open for the next entry.
// Every path fails open: FULI slow, down or broken never blocks or crashes
// OpenCode, and adds at most one line for that turn.

export const OPENCODE_LIFECYCLE_MARKER = '--fuli-opencode-lifecycle';
const OPENCODE_PLUGIN_ID = 'fuli';

// The hook answers by its own deadline (--timeout-ms); this covers a Node
// that never starts or never exits.
const KILL_GRACE_MS = 1500;
// A close is short work; the next prompt of the session waits for it.
const STOP_TIMEOUT_MS = 5_000;
const MAX_ANSWER_BYTES = 512 * 1024;
// FULI keeps no more of a task prompt than this (begin_task_context).
const MAX_PROMPT_CHARS = 8192;
const TERMINAL_EVENTS = Object.freeze(['session.execution.succeeded', 'session.execution.failed',
  'session.execution.interrupted']);

export function fuliOpenCodePlugin({ nodePath, hookPath, runtimeConfigPath, events, timeoutMs },
  { runHook = spawnHook } = {}) {
  const wanted = new Set(events);
  const run = (event, input, limitMs = timeoutMs) => runHook({ command: nodePath, input, killAfterMs: limitMs + KILL_GRACE_MS,
    args: [hookPath, OPENCODE_LIFECYCLE_MARKER, '--runtime-config', runtimeConfigPath, '--event', event,
      '--timeout-ms', String(limitMs)] });
  return {
    id: OPENCODE_PLUGIN_ID,
    async setup(ctx) {
      // An OpenCode without the V2 session hooks gets nothing, not a crash.
      if (typeof ctx?.session?.hook !== 'function') return undefined;
      const entries = new Map();
      const entered = new Set();
      const queue = sessionQueue();
      if (wanted.has('prompt')) {
        await ctx.session.hook('prompt', async (event) => {
          try {
            const sessionID = event?.sessionID;
            const text = event?.prompt?.text;
            if (typeof sessionID !== 'string' || typeof text !== 'string') return;
            const session = await sessionInfo(ctx, sessionID);
            // A subagent's child session belongs to its parent's task.
            if (session?.parentID) return;
            entries.delete(sessionID);
            entered.add(sessionID);
            const answer = await queue(sessionID, () => run('prompt', { session_id: sessionID,
              message_id: event.messageID, cwd: workingDirectory(session, ctx), prompt: text.slice(0, MAX_PROMPT_CHARS) }));
            entries.set(sessionID, typeof answer?.context === 'string' && answer.context.trim()
              ? answer.context : unavailableNotice(answer?.cause));
          } catch {
            // Never block or crash OpenCode; this turn runs without FULI.
          }
        });
      }
      await ctx.session.hook('context', (event) => {
        const text = entries.get(event?.sessionID);
        if (text && Array.isArray(event.system)) event.system.push({ type: 'text', text });
      });
      const controller = new AbortController();
      void (async () => {
        for await (const item of ctx.event.subscribe({ signal: controller.signal })) {
          const sessionID = item?.data?.sessionID;
          if (!TERMINAL_EVENTS.includes(item?.type) || !entered.has(sessionID)) continue;
          entries.delete(sessionID);
          entered.delete(sessionID);
          if (item.type === 'session.execution.succeeded' && wanted.has('execution.succeeded')) {
            void queue(sessionID, () => run('stop', { session_id: sessionID }, Math.min(timeoutMs, STOP_TIMEOUT_MS)))
              .catch(() => {});
          }
        }
      })().catch(() => {
        // Without the event stream tasks stay open; the next entry reports them.
      });
      return () => controller.abort();
    }
  };
}

function unavailableNotice(cause = 'no answer') {
  return `Fuli context is unavailable (${cause}). Continue with the user request; FULI memory and preferences were not loaded for this turn.`;
}

async function sessionInfo(ctx, sessionID) {
  try {
    return await ctx.session.get?.({ sessionID }) ?? null;
  } catch {
    return null;
  }
}

function workingDirectory(session, ctx) {
  const directory = session?.location?.directory ?? ctx.location?.directory;
  return typeof directory === 'string' && session?.subpath ? join(directory, session.subpath) : directory;
}

// One hook at a time per session, so a stop never overlaps the next prompt's entry.
function sessionQueue() {
  const tails = new Map();
  return (sessionID, task) => {
    const next = (tails.get(sessionID) ?? Promise.resolve()).then(task, task);
    const tail = next.catch(() => {});
    tails.set(sessionID, tail);
    void tail.then(() => { if (tails.get(sessionID) === tail) tails.delete(sessionID); });
    return next;
  };
}

function spawnHook({ command, args, input, killAfterMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve({ cause: 'FULI could not be started' });
      return;
    }
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      resolve({ cause: `no answer within ${killAfterMs} ms` });
    }, killAfterMs);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_ANSWER_BYTES) chunks.push(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ cause: 'FULI could not be started' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({ cause: 'FULI gave no answer' });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
