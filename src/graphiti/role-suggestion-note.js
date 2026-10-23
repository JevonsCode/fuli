import { captureDecision, taskCaptureScope } from './capture-decision.js';

// A role's console copy of what it showed after asking its model (rec#8). It
// keeps model text, so it is a capture write like any other (rec#11 D-01):
// kept only when the central decision for the call's trusted scope allows it.
// A role reads that decision as its last await, then decides its final
// result and keeps it synchronously, so no permission can change in between.
// A scope or decision that cannot be read keeps nothing. The role's answer to
// the session never depends on it.
// scope(): the capture scope, read here so a failure to read it keeps nothing.
// Returns keep(entry), to call with the final result.
// The space's permanent-delete generation for a console copy, read before
// the role reads its evidence (rec#10 D-30.9): a delete that begins or ends
// after it keeps the copy's words out. null without a log.
export function suggestionDeletionGeneration(application, personalSpaceId) {
  return application.roleSuggestions?.deletionGeneration(personalSpaceId) ?? null;
}

// Resolve the host session through its task token, not the journal link or a tool argument.
export async function suggestionSessionGeneration(application, personalSpaceId, task) {
  if (!application.roleSuggestions) return null;
  try {
    // The entry already holds its opening text. A deletion during this trust
    // lookup must not relabel that old text as a post-deletion generation.
    const before = application.roleSuggestions.deletionGeneration(personalSpaceId);
    const scope = taskCaptureScope(await application.taskContextRegistry.context(task.token, task.sourceApplication));
    const after = application.roleSuggestions.deletionGeneration(personalSpaceId);
    if (!before || !after || after.some(id => !before.includes(id))) return null;
    return application.roleSuggestions.sessionGeneration(personalSpaceId,
      { sourceApplication: scope.sourceApplication, sessionId: scope.boundSessionId });
  } catch { return null; }
}

export async function prepareRoleSuggestionNote(application, scope, personalSpaceId = application.config?.personal?.spaceId) {
  if (!application.roleSuggestions) return () => {};
  let allowed;
  try {
    if (application.knowledgeRecoveryGate) await application.knowledgeRecoveryGate.refresh(personalSpaceId);
    allowed = (await captureDecision(application, await scope())).allowed;
  } catch {
    allowed = false;
  }
  return entry => {
    if (!allowed) return;
    try {
      return application.roleSuggestions.record(entry);
    } catch {
      // Only the console copy is missing.
    }
  };
}
