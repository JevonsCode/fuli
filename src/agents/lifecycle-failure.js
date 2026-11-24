import { dirname } from 'node:path';

import { diagnosticEventLog } from '../diagnostics/event-log.js';
import { errorCode, failureReason } from '../diagnostics/safe-event.js';
import { resolveGraphRuntimeOptions } from '../graphiti/runtime-config.js';
import { HookInputTooLarge } from './lifecycle-input.js';
import { hookFailureCause } from './lifecycle-message.js';
import { fuliUnavailableGuidance } from '../local-runtime/unavailable-guidance.js';

// A lifecycle hook that failed records it in the data directory's diagnostics
// log (rec#73), with its cause and the session as correlation. Common to
// every Agent's hook; each passes its own client and event. Never throws:
// the hook's answer is already decided.
export function recordHookFailure({ runtimeConfigPath, client, event, error, sessionId = null, startedAt = null,
  now = Date.now }) {
  if (typeof runtimeConfigPath !== 'string' || !runtimeConfigPath) return false;
  return diagnosticEventLog(dirname(runtimeConfigPath)).record({
    component: 'hook', operation: `${client}.${event ?? 'unknown'}`, outcome: 'failed',
    // A controlled error's message names the refused field or rule without its value (rec#85).
    code: errorCode(error), reason: failureReason(error, hookFailureCause(error)),
    durationMs: Number.isFinite(startedAt) ? Math.round(now() - startedAt) : null,
    correlationId: typeof sessionId === 'string' ? sessionId : null
  });
}

// Which case FULI's absence is and what the AI may do about it
// (unavailable-guidance.js), appended to every Agent's "FULI unavailable" text.
// A hook that failed on its own input (unreadable or oversized, a refused argument)
// says nothing of FULI: FULI may well be running. One whose call to the
// console was refused knows nothing listens there, so it is never told busy.
export function consoleRecoveryNotice(runtimeConfigPath, error = null) {
  if (typeof runtimeConfigPath !== 'string' || !runtimeConfigPath || inputFailure(error)) return '';
  const notice = fuliUnavailableGuidance(dirname(runtimeConfigPath), { refused: error?.code === 'fuli_not_running' });
  return notice ? ` ${notice}` : '';
}

// The runtime configuration a hook process was started with, as the hook
// itself resolves it; null when even that cannot be resolved.
export function runtimeConfigPathOf(args, env = process.env, cwd = undefined) {
  try { return resolveGraphRuntimeOptions(args, env, cwd === undefined ? {} : { setupPaths: { cwd } }).runtimeConfigPath; }
  catch { return null; }
}

function inputFailure(error) {
  return error instanceof HookInputTooLarge || error?.name === 'SyntaxError'
    || ['invalid_input', 'validation'].includes(error?.code);
}
