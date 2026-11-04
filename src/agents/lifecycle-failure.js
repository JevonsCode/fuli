import { dirname } from 'node:path';

import { diagnosticEventLog } from '../diagnostics/event-log.js';
import { errorCode } from '../diagnostics/safe-event.js';
import { resolveGraphRuntimeOptions } from '../graphiti/runtime-config.js';
import { hookFailureCause } from './lifecycle-message.js';

// A lifecycle hook that failed records it in the data directory's diagnostics
// log (rec#73), with the same cause its client was shown and the session as
// correlation. Common to every Agent's hook; each passes its own client and
// event. Never throws: the hook's answer is already decided.
export function recordHookFailure({ runtimeConfigPath, client, event, error, sessionId = null, startedAt = null,
  now = Date.now }) {
  if (typeof runtimeConfigPath !== 'string' || !runtimeConfigPath) return false;
  return diagnosticEventLog(dirname(runtimeConfigPath)).record({
    component: 'hook', operation: `${client}.${event ?? 'unknown'}`, outcome: 'failed',
    code: errorCode(error), reason: hookFailureCause(error),
    durationMs: Number.isFinite(startedAt) ? Math.round(now() - startedAt) : null,
    correlationId: typeof sessionId === 'string' ? sessionId : null
  });
}

// The runtime configuration a hook process was started with, as the hook
// itself resolves it; null when even that cannot be resolved.
export function runtimeConfigPathOf(args, env = process.env) {
  try { return resolveGraphRuntimeOptions(args, env).runtimeConfigPath; } catch { return null; }
}
