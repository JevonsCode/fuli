import { captureDecision } from './capture-decision.js';

// A role's console copy of what it showed after asking its model (rec#8). It
// keeps model text, so it is a capture write like any other (rec#11 D-01):
// kept only when the central decision for the call's trusted scope allows it
// at the moment of writing, which is after every await of the role's work.
// A scope or decision that cannot be read keeps nothing. The role's answer to
// the session never depends on it.
// scope(): the capture scope, read here so a failure to read it keeps nothing.
export async function noteRoleSuggestion(application, scope, entry) {
  if (!application.roleSuggestions) return;
  try {
    const capture = await captureDecision(application, await scope());
    if (capture.allowed) application.roleSuggestions.record(entry);
  } catch {
    // Unknown is off; only the console copy is missing.
  }
}
