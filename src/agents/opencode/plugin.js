import { join } from 'node:path';

import { bounded, entryText, KILL_GRACE_MS, MAX_PROMPT_CHARS, sessionQueue, spawnHook } from '../plugin-hook-process.js';

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
//   the turn OpenCode delivered (the one whose requests these are);
// - the turn's close, as a Stop hook: on the `session.execution.succeeded` of
//   the execution that ran it (events follow OpenCode's run reducer: they
//   belong to the delivered turn, never to a prompt still being admitted),
//   when a newer prompt begins its task (FULI keeps one current task per
//   session), when it is cancelled after its task began, or when OpenCode
//   unloads the plugin with the turn still open and the session recorded a
//   successful execution since it ran. A failed or interrupted execution
//   closes nothing, as an interrupted Claude Code or Codex turn runs no Stop
//   hook; its task stays open for the next entry. Each turn closes once.
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

// A close is short work; the next prompt of the session waits for it.
const STOP_TIMEOUT_MS = 5_000;
// Reading a session (child or not, its directory, its outcome) is bounded so
// admission stays inside the pack's timeout and unload stays short.
const SESSION_LOOKUP_MS = 300;
const UNLOAD_HANDOFF_MS = 1_000;
// Session idle times come from OpenCode's clock in this same process; this
// absorbs rounding to the millisecond it records.
const IDLE_TOLERANCE_MS = 1_000;
const TERMINAL_EVENTS = Object.freeze(['session.execution.succeeded', 'session.execution.failed',
  'session.execution.interrupted']);
const DELIVERED_EVENT = 'session.inbox.delivered';
const CANCELLED_EVENT = 'session.inbox.cancelled';

export function fuliOpenCodePlugin({ nodePath, hookPath, runtimeConfigPath, events, timeoutMs },
  { runHook = spawnHook, now = Date.now, env = process.env } = {}) {
  const wanted = new Set(events);
  // OpenCode inside WSL reports paths of its distribution's own file system;
  // a Windows FULI opens them through that distribution's share
  // (wslCallerPath), and its Node does not inherit WSL_DISTRO_NAME.
  const distribution = typeof env.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME
    ? { wsl_distribution: env.WSL_DISTRO_NAME } : {};
  const run = (event, input, limitMs, extra = {}) => runHook({ command: nodePath, input, killAfterMs: limitMs + KILL_GRACE_MS,
    args: [hookPath, OPENCODE_LIFECYCLE_MARKER, '--runtime-config', runtimeConfigPath, '--event', event,
      '--timeout-ms', String(limitMs)], ...extra });
  return {
    id: OPENCODE_PLUGIN_ID,
    async setup(ctx) {
      // An OpenCode without the V2 session hooks gets nothing, not a crash.
      if (typeof ctx?.session?.hook !== 'function') return undefined;
      // Per session, as OpenCode's own run reducer sees it: `running` is the
      // turn OpenCode delivered, which execution events belong to; `pending`
      // are prompts admitted but not yet delivered. A steer prompt's task
      // begins at admission (OpenCode awaits this hook before it enters the
      // inbox), a queued one's when it is delivered.
      const sessions = new Map();
      const handoffs = new Set();
      const queue = sessionQueue();
      const stateOf = (sessionID) => {
        if (!sessions.has(sessionID)) sessions.set(sessionID, { running: null, pending: [] });
        return sessions.get(sessionID);
      };

      // Starts the turn's entry behind anything the session's hooks still run;
      // its deadline counts from when its own hook starts.
      const begin = (sessionID, turn) => {
        turn.entry = queue(sessionID, () => run('prompt', { session_id: sessionID, message_id: turn.messageID,
          cwd: turn.cwd, prompt: turn.text, ...distribution }, timeoutMs))
          .then(entryText, () => entryText());
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
      // The pending turn at `index` becomes the running turn: the one OpenCode
      // delivered, or, where the session shows no deliveries, the one its
      // execution evidently runs. The running turn and earlier prompts are over.
      const runTurn = (sessionID, index) => {
        const state = sessions.get(sessionID);
        if (!state || index < 0 || index >= state.pending.length) return;
        const earlier = state.pending.splice(0, index + 1);
        const turn = earlier.pop();
        for (const over of [state.running, ...earlier]) if (over?.entry) close(sessionID, over);
        state.running = turn;
        // It runs from now: an outcome before this is another turn's.
        turn.since = now();
        if (!turn.entry && !turn.closed) begin(sessionID, turn);
      };
      const deliver = (sessionID, messageID) => {
        const state = sessions.get(sessionID);
        if (!state) return;
        state.deliveries = true;
        runTurn(sessionID, state.pending.findIndex((turn) => turn.messageID === messageID));
      };
      // Without delivery events, an execution's end is the oldest admitted
      // prompt's, and a request runs the oldest one still open; a request
      // after a newer prompt began (the running turn closed for it) is the
      // newer prompt's.
      const assumeRunning = (sessionID, { open }) => {
        const state = sessions.get(sessionID);
        if (!state || state.deliveries || (state.running && !(open && state.running.closed))) return;
        runTurn(sessionID, open ? state.pending.findIndex((turn) => !turn.closed) : 0);
      };
      // A pending prompt the person withdrew never runs; a task it began is closed.
      const cancel = (sessionID, messageID) => {
        const state = sessions.get(sessionID);
        const index = state?.pending.findIndex((turn) => turn.messageID === messageID) ?? -1;
        if (index < 0) return;
        const [turn] = state.pending.splice(index, 1);
        if (turn.entry) close(sessionID, turn);
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
              const session = await bounded(sessionInfo(ctx, sessionID), SESSION_LOOKUP_MS);
              // A subagent's child session belongs to its parent's task.
              if (session?.parentID) return;
              const state = stateOf(sessionID);
              const turn = { messageID: event.messageID, since: now(), cwd: workingDirectory(session, ctx),
                text: text.slice(0, MAX_PROMPT_CHARS), entry: null, closed: false };
              state.pending.push(turn);
              const begun = [state.running, ...state.pending].filter((other) => other?.entry && !other.closed);
              // Queued behind a running turn: its task begins when OpenCode delivers it.
              if (event.delivery === 'queue' && (state.running || begun.length)) return;
              // FULI keeps one current task per session, and its stop closes the
              // current one: every begun turn closes before this one begins.
              for (const other of begun) close(sessionID, other);
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
            // A request with no turn running: a queued prompt's next execution,
            // or a session whose deliveries were not seen.
            if (state.deliveries && !state.running) runTurn(event.sessionID, state.pending.findIndex((turn) => !turn.closed));
            else assumeRunning(event.sessionID, { open: true });
            const text = await state.running?.entry;
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
            if (item.type === CANCELLED_EVENT) cancel(sessionID, item.data.inboxID);
            if (!TERMINAL_EVENTS.includes(item.type)) continue;
            // An execution's end belongs to the turn it ran, never to one still pending.
            assumeRunning(sessionID, { open: false });
            if (!state.running) continue;
            if (item.type === 'session.execution.succeeded') close(sessionID, state.running);
            state.running = null;
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
        await Promise.all([...sessions].map(async ([sessionID, state]) => {
          const running = state.running ?? (state.deliveries ? null : state.pending[0]);
          if (!running?.entry || running.closed) return;
          const session = await bounded(sessionInfo(ctx, sessionID), SESSION_LOOKUP_MS);
          if (!session || succeededSince(session, running.since)) close(sessionID, running);
        }));
        // Closes handed off by a success event and by unload alike.
        await bounded(Promise.all([...handoffs]), UNLOAD_HANDOFF_MS);
      };
    }
  };
}

async function sessionInfo(ctx, sessionID) {
  try {
    return await ctx.session.get?.({ sessionID }) ?? null;
  } catch {
    return null;
  }
}

// OpenCode records the last execution's outcome at `time.idle` (schema/src/session.ts).
function succeededSince(session, since) {
  const idle = session?.time?.idle;
  const idleAt = typeof idle === 'number' ? idle : Date.parse(idle);
  return session.outcome === 'succeeded' && Number.isFinite(idleAt) && idleAt >= since - IDLE_TOLERANCE_MS;
}

function workingDirectory(session, ctx) {
  const directory = session?.location?.directory ?? ctx.location?.directory;
  return typeof directory === 'string' && session?.subpath ? join(directory, session.subpath) : directory;
}
