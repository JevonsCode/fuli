import { AsyncLocalStorage } from 'node:async_hooks';
import { activeAgentRequestSignal } from '../app/agent-request-context.js';

const budgets = new AsyncLocalStorage();
const DEFAULT_CAPTURE_MS = 750;
export const withCaptureBudget = (timeoutMs, operation) => budgets.run(timeoutMs, operation);

// Capture/recovery must leave time for preference entry. Revoking this port
// prevents late continuations (even broken ports ignoring AbortSignal) from
// issuing more requests or touching a guard after its lock has been released.
export async function captureWindow(application, guard, operation, {
  timeoutMs = budgets.getStore() ?? DEFAULT_CAPTURE_MS, signal = activeAgentRequestSignal()
} = {}) {
  const controller = new AbortController();
  let active = true, timer;
  const error = () => Object.assign(new Error('Transcript capture budget expired'), { code: 'transcript_capture_timeout' });
  const check = () => { if (!active || controller.signal.aborted) throw error(); };
  const options = current => ({ ...current, signal: controller.signal,
    timeoutMs: Math.min(current?.timeoutMs ?? timeoutMs, timeoutMs) });
  const port = { config: application.config,
    // Capture decisions inside the window resolve the session's directory too.
    resolveProjectPath: projectPath => { check(); return application.resolveProjectPath(projectPath); },
    getCapturePolicy: application.getCapturePolicy?.bind(application), personal: {
      currentTaskContext: (query, current) => { check(); return application.personal.currentTaskContext(query, options(current)); },
      conversation: (action, query, current) => { check(); return application.personal.conversation(action, query, options(current)); }
    } };
  const guarded = guard && {
    get value() { check(); return guard.value; }, get expired() { check(); return guard.expired; },
    write: next => { check(); return guard.write(next); }, clear: () => { check(); return guard.clear(); }
  };
  let cancel;
  const expired = new Promise((_, reject) => {
    cancel = () => { active = false; guard?.invalidate?.(); controller.abort(); reject(error()); };
    timer = setTimeout(cancel, timeoutMs);
  });
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) cancel();
    return await Promise.race([Promise.resolve().then(() => { check(); return operation(port, guarded); }), expired]);
  } finally {
    active = false;
    controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
