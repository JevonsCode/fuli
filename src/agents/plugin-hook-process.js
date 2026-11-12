import { spawn } from 'node:child_process';

// How a client plugin that runs inside the client's own process (OpenCode's
// Bun, DeepSeek Harness's Node) reaches FULI: each lifecycle event starts the
// client's FULI lifecycle hook with FULI's Node, as the Claude Code and Codex
// hooks are started, and reads one JSON answer. This module imports Node
// built-ins only, so a client can load it without FULI's dependencies.

// The hook answers by its own deadline (--timeout-ms); this covers a Node
// that never starts or never exits.
export const KILL_GRACE_MS = 1500;
const MAX_ANSWER_BYTES = 512 * 1024;
// FULI keeps no more of a task prompt than this (begin_task_context).
export const MAX_PROMPT_CHARS = 8192;

// The one line a turn gets when FULI cannot answer.
export function unavailableNotice(cause = 'no answer') {
  return `Fuli context is unavailable (${cause}). Continue with the user request; FULI memory and preferences were not loaded for this turn.`;
}

// A prompt answer's context text, or the one line saying why there is none.
export function entryText(answer) {
  return typeof answer?.context === 'string' && answer.context.trim() ? answer.context : unavailableNotice(answer?.cause);
}

export function bounded(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms, null); })])
    .finally(() => clearTimeout(timer));
}

// One hook at a time per session, so a stop never overlaps the next prompt's entry.
export function sessionQueue() {
  const tails = new Map();
  return (sessionID, task) => {
    const next = (tails.get(sessionID) ?? Promise.resolve()).then(task, task);
    const tail = next.catch(() => {});
    tails.set(sessionID, tail);
    void tail.then(() => { if (tails.get(sessionID) === tail) tails.delete(sessionID); });
    return next;
  };
}

// `detached`: a close outlives the client's shutdown in its own process group,
// reads nothing back and keeps nothing alive; `onSent` runs once its input is
// handed over (or it could not start).
export function spawnHook({ command, args, input, killAfterMs, detached = false, onSent = () => {} }) {
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
