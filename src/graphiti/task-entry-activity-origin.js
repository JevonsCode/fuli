import { activeSealedWorkerRequest } from '../app/agent-request-context.js';

// Internal Agent activity is recognized only from provenance the host produced
// and the entry process inherited, never from prompt text or tool payloads.
// Two sources exist: a roundtable wake, whose host sets a per-attempt Provider
// grant in the woken client's environment, and a sealed worker call that the
// worker MCP composition marks after the Provider admitted its run. Sealed
// workers enter through worker-task-context and never reach ordinary task
// entry; their marker matters for checkpoint capture. A missing marker means
// unknown provenance (including older clients), not a human.
export function hostInternalActivity(application, { sessionId = null } = {}) {
  if (activeSealedWorkerRequest()) return 'sealed_worker';
  return application.roundtable?.taskEntryDelegation?.({ sessionId }) ? 'roundtable_delegation' : null;
}
