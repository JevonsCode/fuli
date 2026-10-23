import { captureDecision } from './capture-decision.js';

// A role's console copy of what it showed after asking its model (rec#8). It
// keeps model text, so it is a capture write like any other (rec#11 D-01):
// kept only when the central decision for the call's trusted scope allows it.
// A role reads that decision as its last await, then decides its final
// result and keeps it synchronously, so no permission can change in between.
// A scope or decision that cannot be read keeps nothing. The role's answer to
// the session never depends on it.
// scope(): the capture scope, read here so a failure to read it keeps nothing.
// Returns keep(entry), to call with the final result.
export async function prepareRoleSuggestionNote(application, scope) {
  if (!application.roleSuggestions) return () => {};
  let allowed;
  try {
    allowed = (await captureDecision(application, await scope())).allowed;
  } catch {
    allowed = false;
  }
  return entry => {
    if (!allowed) return;
    try {
      application.roleSuggestions.record(entry);
    } catch {
      // Only the console copy is missing.
    }
  };
}
