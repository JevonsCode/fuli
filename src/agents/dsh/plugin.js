import { randomUUID } from 'node:crypto';

import { bounded, entryText, KILL_GRACE_MS, MAX_PROMPT_CHARS, sessionQueue, spawnHook } from '../plugin-hook-process.js';

// The DeepSeek Harness (DSH) Cordis plugin. DSH loads it inside its own Node
// process from the bundle FULI setup installs into each DSH profile
// (bundle.js), so this module imports Node built-ins only and never a DSH
// package: the bundle is linked from FULI's installation, where no DSH
// package resolves. Each event starts FULI's lifecycle hook
// (lifecycle-hook.js) with FULI's Node. A turn is one prompt of the person:
// - its first step (`agent/pre-step`, step 1, a waterfall the loop awaits
//   before the step's messages are committed) begins its task and appends
//   the entry as one context message after the person's own, which stays
//   unchanged. DSH keeps that message in the session history, so later steps
//   of the turn need no second copy;
// - its close, as a Stop hook: `turn/end` with reason `completed`. An error or
//   a cancellation closes nothing, as an interrupted Claude Code or Codex turn
//   runs no Stop hook; its task stays open for the next entry. Each turn
//   closes once.
// A subagent's session (`header.origin === 'subagent'`) belongs to its
// parent's task. Every path fails open: FULI slow, down or broken never blocks
// or crashes DSH, and adds at most one line for that turn.
//
// `dsh --profile headless` exits right after the turn's end, so a close runs
// detached from DSH's process group, holds nothing open, and disposal only
// waits until each close's input is handed over.

export const DSH_LIFECYCLE_MARKER = '--fuli-dsh-lifecycle';
const PLUGIN_NAME = 'fuli';
// The message source kind DSH records for FULI's entry; DSH's consumers fall
// through kinds they do not know.
const CONTEXT_SOURCE = Object.freeze({ kind: 'fuli-context', form: 'instructions' });
// A close is short work; the next prompt of the session waits for it.
const STOP_TIMEOUT_MS = 5_000;
const DISPOSE_HANDOFF_MS = 1_000;

export function fuliDshPlugin({ nodePath, hookPath, runtimeConfigPath, timeoutMs }, { runHook = spawnHook } = {}) {
  const run = (event, input, limitMs, extra = {}) => runHook({ command: nodePath, input, killAfterMs: limitMs + KILL_GRACE_MS,
    args: [hookPath, DSH_LIFECYCLE_MARKER, '--runtime-config', runtimeConfigPath, '--event', event,
      '--timeout-ms', String(limitMs)], ...extra });
  return {
    name: PLUGIN_NAME,
    inject: ['agents'],
    apply(ctx) {
      // Per session, the turn whose task began and has not closed.
      const open = new Map();
      const handoffs = new Set();
      const queue = sessionQueue();

      const close = (sessionId) => {
        const handoff = new Promise((resolve) => {
          queue(sessionId, () => run('stop', { session_id: sessionId }, Math.min(timeoutMs, STOP_TIMEOUT_MS),
            { detached: true, onSent: resolve })).catch(() => {}).finally(resolve);
        });
        handoffs.add(handoff);
        void handoff.finally(() => handoffs.delete(handoff));
      };

      // prepend: the listeners after this one run first, so the entry comes
      // after every other contributor's messages and sees the final batch.
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        try {
          if (decision?.kind !== 'enter' || payload?.step !== 1 || payload.signal?.aborted) return decision;
          const session = payload.agent?.session;
          const sessionId = session?.id ?? session?.header?.id;
          const prompt = promptOf(decision.messages);
          if (typeof sessionId !== 'string' || !prompt || session?.header?.origin === 'subagent') return decision;
          open.set(sessionId, { turn: payload.turn });
          const answer = await queue(sessionId, () => run('prompt', { session_id: sessionId,
            ...(prompt.id ? { message_id: prompt.id } : {}), cwd: session.header?.cwd ?? process.cwd(),
            prompt: prompt.text }, timeoutMs)).catch(() => undefined);
          if (payload.signal?.aborted) return decision;
          return { ...decision, messages: [...decision.messages, contextMessage(entryText(answer))] };
        } catch {
          // The step goes out without FULI's entry.
          return decision;
        }
      }, { prepend: true });

      ctx.on('session/event', (session, event) => {
        try {
          if (event?.type !== 'turn/end') return;
          const sessionId = session?.id ?? session?.header?.id;
          const turn = open.get(sessionId);
          if (!turn || turn.turn !== event.data?.turn) return;
          open.delete(sessionId);
          if (event.data?.reason?.kind === 'completed') close(sessionId);
        } catch {
          // The next entry reports a turn left open.
        }
      });

      ctx.effect(() => () => bounded(Promise.all([...handoffs]), DISPOSE_HANDOFF_MS), 'fuli.handoffs()');
    }
  };
}

// The person's words that opened the turn: the text of its user-sourced
// messages, and the first one's id.
function promptOf(messages) {
  const own = Array.isArray(messages) ? messages.filter((message) => message?.role === 'user' && message.source?.kind === 'user') : [];
  const text = own.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n').trim();
  return text ? { id: typeof own[0].id === 'string' ? own[0].id : null, text: text.slice(0, MAX_PROMPT_CHARS) } : null;
}

function contextMessage(text) {
  return Object.freeze({ id: randomUUID(), role: 'user', source: CONTEXT_SOURCE,
    content: Object.freeze([Object.freeze({ type: 'text', text })]) });
}
