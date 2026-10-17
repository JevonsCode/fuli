// Internal Agent activity is recognized only from provenance the host produced
// and the entry process inherited, never from prompt text or tool payloads.
// Today that is one source: a roundtable wake, whose host sets a per-attempt
// Provider grant in the woken client's environment. Sealed workers enter
// through worker-task-context and never reach ordinary task entry. A missing
// marker means unknown provenance (including older clients), not a human.
export function hostInternalActivity(application, { sessionId = null } = {}) {
  return application.roundtable?.taskEntryDelegation?.({ sessionId }) ? 'roundtable_delegation' : null;
}
