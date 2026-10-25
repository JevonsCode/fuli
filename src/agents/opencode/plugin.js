import { spawn } from 'node:child_process';
import { join } from 'node:path';

// The OpenCode V2 server plugin (rec#11 D-63). OpenCode loads it inside its
// own Bun process through the file FULI setup writes into OpenCode's plugins
// directory (plugin-file.js), so this module imports Node built-ins only.
// Each event starts FULI's lifecycle hook (lifecycle-hook.js) with FULI's
// Node, as the Claude Code and Codex hooks are started. A turn is one prompt
// of the person:
// - `prompt` (session.hook "prompt", at prompt admission) begins its task and
//   keeps its entry; the person's prompt text is never changed. A prompt
//   queued behind a running turn (delivery "queue") begins only when OpenCode
//   delivers it (session.inbox.delivered), after the turn before it closed;
// - `context` (before each model request, not persisted) adds the entry of
//   the session's current turn as system text;
// - the turn's close, as a Stop hook: on `session.execution.succeeded`, when
//   the next prompt of its session is delivered, or when OpenCode unloads the
//   plugin with the turn still open and the session recorded a successful
//   execution since the prompt. A failed or interrupted execution closes
//   nothing, as an interrupted Claude Code or Codex turn runs no Stop hook; its
//   task stays open for the next entry. Each turn closes once.
// Every path fails open: FULI slow, down or broken never blocks or crashes
// OpenCode, and adds at most one line for that turn.
//
// `opencode run --standalone` (2.1.4) exits as soon as it reads the
// succeeded event (cli/src/run/noninteractive.ts), which closes its server's
// stdin lease; the server then shuts down (cli/src/server-process.ts), its
// plugin scope runs this plugin's cleanup (plugin/src/promise/adapter.ts),
// and its own children are stopped with it (SIGTERM, then a kill after 3 s).
// So a close runs detached from OpenCode's process group, holds nothing open,
// and unload only waits until each close's input is handed over.

export const OPENCODE_LIFECYCLE_MARKER = '--fuli-opencode-lifecycle';
const OPENCODE_PLUGIN_ID = 'fuli';

// The hook answers by its own deadline (--timeout-ms); this covers a Node
// that never starts or never exits.
const KILL_GRACE_MS = 1500;
// A close is short work; the next prompt of the session waits for it.
const STOP_TIMEOUT_MS = 5_000;
// Below this, an entry cannot finish and is not started.
const MIN_ENTRY_MS = 1_000;
// Reading a session (child or not, its directory, its outcome) is bounded so
// admission stays inside the pack's timeout and unload stays short.
const SESSION_LOOKUP_MS = 300;
const UNLOAD_HANDOFF_MS = 1_000;
// Session idle times come from OpenCode's clock in this same process; this
// absorbs rounding to the millisecond it records.
const IDLE_TOLERANCE_MS = 1_000;
const MAX_ANSWER_BYTES = 512 * 1024;
// FULI keeps no more of a task prompt than this (begin_task_context).
const MAX_PROMPT_CHARS = 8192;
const TERMINAL_EVENTS = Object.freeze(['session.execution.succeeded', 'session.execution.failed',
  'session.execution.interrupted']);
const DELIVERED_EVENT = 'session.inbox.delivered';

export function fuliOpenCodePlugin({ nodePath, hookPath, runtimeConfigPath, events, timeoutMs },
  { runHook = spawnHook, now = Date.now } = {}) {
  const wanted = new Set(events);
  const run = (event, input, limitMs, extra = {}) => runHook({ command: nodePath, input, killAfterMs: limitMs + KILL_GRACE_MS,
    args: [hookPath, OPENCODE_LIFECYCLE_MARKER, '--runtime-config', runtimeConfigPath, '--event', event,
      '--timeout-ms', String(limitMs)], ...extra });
  return {
    id: OPENCODE_PLUGIN_ID,
    async setup(ctx) {
      // An OpenCode without the V2 session hooks gets nothing, not a crash.
      if (typeof ctx?.session?.hook !== 'function') return undefined;
      // Per session: the turn whose requests run now, and prompts queued behind it.
      const sessions = new Map();
      const handoffs = new Set();
      const queue = sessionQueue();
      const stateOf = (sessionID) => {
        if (!sessions.has(sessionID)) sessions.set(sessionID, { active: null, waiting: [] });
        return sessions.get(sessionID);
      };

      // Starts the turn's entry behind anything the session's hooks still run,
      // within what is left of the time since its admission.
      const begin = (sessionID, turn) => {
        sessions.get(sessionID).active = turn;
        turn.entry = queue(sessionID, async () => {
          const limitMs = timeoutMs - (now() - turn.admittedAt);
          if (limitMs < MIN_ENTRY_MS) return { cause: `no answer within ${timeoutMs} ms` };
          return run('prompt', { session_id: sessionID, message_id: turn.messageID, cwd: turn.cwd,
            prompt: turn.text }, limitMs);
        }).then((answer) => typeof answer?.context === 'string' && answer.context.trim()
          ? answer.context : unavailableNotice(answer?.cause), () => unavailableNotice());
        return turn.entry;
      };
      // Each turn closes once, after its own entry and before the next one.
      const close = (sessionID, turn) => {
        if (turn.closed) return;
        turn.closed = true;
        if (!wanted.has('execution.succeeded')) return;
        const handoff = new Promise((resolve) => {
          queue(sessionID, () => run('stop', { session_id: sessionID }, Math.min(timeoutMs, STOP_TIMEOUT_MS),
            { detached: true, onSent: resolve })).catch(() => {}).finally(resolve);
        });
        handoffs.add(handoff);
        void handoff.finally(() => handoffs.delete(handoff));
      };
      // The session's next turn: the prompt OpenCode delivered (or the oldest
      // queued one), which ends the turn before it.
      const deliver = (sessionID, messageID) => {
        const state = sessions.get(sessionID);
        const index = messageID === undefined ? 0 : state?.waiting.findIndex((turn) => turn.messageID === messageID);
        if (!state || index < 0 || index >= state.waiting.length) return null;
        const [turn] = state.waiting.splice(index, 1);
        // Its time runs from now, not from when it was queued.
        turn.admittedAt = now();
        if (state.active) close(sessionID, state.active);
        return begin(sessionID, turn);
      };

      const registrations = [];
      const controller = new AbortController();
      try {
        if (wanted.has('prompt')) {
          registrations.push(await ctx.session.hook('prompt', async (event) => {
            try {
              const sessionID = event?.sessionID;
              const text = event?.prompt?.text;
              if (typeof sessionID !== 'string' || typeof text !== 'string') return;
              const admittedAt = now();
              const session = await bounded(sessionInfo(ctx, sessionID), SESSION_LOOKUP_MS);
              // A subagent's child session belongs to its parent's task.
              if (session?.parentID) return;
              const state = stateOf(sessionID);
              const turn = { messageID: event.messageID, admittedAt, cwd: workingDirectory(session, ctx),
                text: text.slice(0, MAX_PROMPT_CHARS), entry: null, closed: false };
              // Queued behind the running turn: it begins when OpenCode delivers it.
              if (state.active && !state.active.closed && event.delivery === 'queue') {
                state.waiting.push(turn);
                return;
              }
              if (state.active) close(sessionID, state.active);
              await begin(sessionID, turn);
            } catch {
              // Never block or crash OpenCode; this turn runs without FULI.
            }
          }));
        }
        registrations.push(await ctx.session.hook('context', async (event) => {
          try {
            const state = sessions.get(event?.sessionID);
            if (!state || !Array.isArray(event.system)) return;
            // No delivery seen for a queued prompt: the next execution is its turn.
            if (!state.active && state.waiting.length) deliver(event.sessionID);
            const text = await state.active?.entry;
            if (text) event.system.push({ type: 'text', text });
          } catch {
            // The request goes out without FULI's entry.
          }
        }));
        const stream = ctx.event.subscribe({ signal: controller.signal });
        void (async () => {
          for await (const item of stream) {
            const sessionID = item?.data?.sessionID;
            const state = sessions.get(sessionID);
            if (!state) continue;
            if (item.type === DELIVERED_EVENT) deliver(sessionID, item.data.inboxID);
            if (!TERMINAL_EVENTS.includes(item.type) || !state.active) continue;
            if (item.type === 'session.execution.succeeded') close(sessionID, state.active);
            state.active = null;
          }
        })().catch(() => {
          // Without the event stream a turn closes at unload; the next entry reports others.
        });
      } catch {
        // A hook OpenCode refused leaves the plugin inactive, not OpenCode broken.
        controller.abort();
        await Promise.allSettled(registrations.map((registration) => registration?.dispose?.()));
        return undefined;
      }
      return async () => {
        controller.abort();
        // A turn still open at unload closes when its session went idle after
        // a successful execution since the prompt, or when OpenCode can no
        // longer say: it is over either way, as with a Stop hook at exit.
        await Promise.all([...sessions].map(async ([sessionID, { active }]) => {
          if (!active || active.closed) return;
          const session = await bounded(sessionInfo(ctx, sessionID), SESSION_LOOKUP_MS);
          if (!session || succeededSince(session, active.admittedAt)) close(sessionID, active);
        }));
        // Closes handed off by a success event and by unload alike.
        await bounded(Promise.all([...handoffs]), UNLOAD_HANDOFF_MS);
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
