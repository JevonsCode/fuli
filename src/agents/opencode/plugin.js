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
// - the turn's close, as a Stop hook: on `session.execution.succeeded`, or
//   when OpenCode unloads the plugin with the turn still open and the session
//   recorded a successful execution since the prompt. A failed or interrupted
//   execution closes nothing, as an interrupted Claude Code or Codex turn runs
//   no Stop hook; its task stays open for the next entry. Each turn closes once.
// Every path fails open: FULI slow, down or broken never blocks or crashes
// OpenCode, and adds at most one line for that turn.
//
// `opencode run --standalone` (2.1.4) exits as soon as it reads the
// succeeded event (cli/src/run/noninteractive.ts), which closes its server's
// stdin lease; the server then shuts down (cli/src/server-process.ts), its
// plugin scope runs this plugin's cleanup (plugin/src/promise/adapter.ts),
// and its own children are stopped with it (SIGTERM, then a kill after 3 s).
// So a close runs detached from OpenCode's process group, holds nothing open,
// and unload only waits until its input is handed over.

export const OPENCODE_LIFECYCLE_MARKER = '--fuli-opencode-lifecycle';
const OPENCODE_PLUGIN_ID = 'fuli';

// The hook answers by its own deadline (--timeout-ms); this covers a Node
// that never starts or never exits.
const KILL_GRACE_MS = 1500;
// A close is short work; the next prompt of the session waits for it.
const STOP_TIMEOUT_MS = 5_000;
// What unload may spend: reading a session's outcome, handing a close its input.
const UNLOAD_LOOKUP_MS = 300;
const UNLOAD_HANDOFF_MS = 1_000;
// Session idle times come from OpenCode's clock in this same process; this
// absorbs rounding to the millisecond it records.
const IDLE_TOLERANCE_MS = 1_000;
const MAX_ANSWER_BYTES = 512 * 1024;
// FULI keeps no more of a task prompt than this (begin_task_context).
const MAX_PROMPT_CHARS = 8192;
const TERMINAL_EVENTS = Object.freeze(['session.execution.succeeded', 'session.execution.failed',
  'session.execution.interrupted']);

export function fuliOpenCodePlugin({ nodePath, hookPath, runtimeConfigPath, events, timeoutMs },
  { runHook = spawnHook, now = Date.now } = {}) {
  const wanted = new Set(events);
  const stopLimitMs = Math.min(timeoutMs, STOP_TIMEOUT_MS);
  const run = (event, input, limitMs, extra = {}) => runHook({ command: nodePath, input, killAfterMs: limitMs + KILL_GRACE_MS,
    args: [hookPath, OPENCODE_LIFECYCLE_MARKER, '--runtime-config', runtimeConfigPath, '--event', event,
      '--timeout-ms', String(limitMs)], ...extra });
  return {
    id: OPENCODE_PLUGIN_ID,
    async setup(ctx) {
      // An OpenCode without the V2 session hooks gets nothing, not a crash.
      if (typeof ctx?.session?.hook !== 'function') return undefined;
      const entries = new Map();
      // The open turn of each session: its message and when it was admitted.
      const open = new Map();
      const queue = sessionQueue();
      // Takes the session's open turn, so no later path can close it again.
      const closeTurn = (sessionID, { onSent } = {}) => {
        if (!open.delete(sessionID)) return null;
        if (!wanted.has('execution.succeeded')) return null;
        return queue(sessionID, () => run('stop', { session_id: sessionID }, stopLimitMs, { detached: true, onSent }))
          .catch(() => {});
      };
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
            open.set(sessionID, { messageID: event.messageID, admittedAt: now() });
            const answer = await queue(sessionID, () => run('prompt', { session_id: sessionID,
              message_id: event.messageID, cwd: workingDirectory(session, ctx), prompt: text.slice(0, MAX_PROMPT_CHARS) },
            timeoutMs));
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
          if (!TERMINAL_EVENTS.includes(item?.type)) continue;
          entries.delete(sessionID);
          if (item.type === 'session.execution.succeeded') closeTurn(sessionID);
          else open.delete(sessionID);
        }
      })().catch(() => {
        // Without the event stream a turn closes at unload; the next entry reports others.
      });
      return async () => {
        controller.abort();
        // A turn still open at unload closes when its session went idle after
        // a successful execution since the prompt, or when OpenCode can no
        // longer say: it is over either way, as with a Stop hook at exit.
        const turns = [...open];
        const closing = await Promise.all(turns.map(async ([sessionID, turn]) => {
          const session = await bounded(sessionInfo(ctx, sessionID), UNLOAD_LOOKUP_MS);
          if (session && !succeededSince(session, turn.admittedAt)) return null;
          return new Promise((resolve) => {
            if (!closeTurn(sessionID, { onSent: resolve })) resolve();
          });
        }));
        await bounded(Promise.all(closing), UNLOAD_HANDOFF_MS);
      };
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

// OpenCode records the last execution's outcome at `time.idle` (schema/src/session.ts).
function succeededSince(session, admittedAt) {
  const idle = session?.time?.idle;
  const idleAt = typeof idle === 'number' ? idle : Date.parse(idle);
  return session.outcome === 'succeeded' && Number.isFinite(idleAt) && idleAt >= admittedAt - IDLE_TOLERANCE_MS;
}

function bounded(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms, null); })])
    .finally(() => clearTimeout(timer));
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

// `detached`: a close outlives OpenCode's shutdown in its own process group,
// reads nothing back and keeps nothing alive; `onSent` runs once its input is
// handed over (or it could not start).
function spawnHook({ command, args, input, killAfterMs, detached = false, onSent = () => {} }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', detached ? 'ignore' : 'pipe', 'ignore'], windowsHide: true, detached });
    } catch {
      onSent();
      resolve({ cause: 'FULI could not be started' });
      return;
    }
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      resolve({ cause: `no answer within ${killAfterMs} ms` });
    }, killAfterMs);
    if (detached) {
      child.unref();
      timer.unref();
    }
    child.stdout?.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_ANSWER_BYTES) chunks.push(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      onSent();
      resolve({ cause: 'FULI could not be started' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(detached ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({ cause: 'FULI gave no answer' });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input), () => onSent());
  });
}
