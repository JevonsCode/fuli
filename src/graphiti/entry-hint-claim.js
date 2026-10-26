import { entryHintSkipped } from '../conversations/entry-budget.js';

// The session's one claim of a task-entry hint (rec#10 D-26.4), taken once
// every other reason to show nothing has been checked. With too little of the
// hook's time left nothing is claimed, so a later entry may still ask; the
// skip is shown only where the hint could still have been shown, never after
// the session already used it. true when claimed, otherwise what to show.
export async function claimEntryHint(application, task, operation) {
  const registry = application.taskContextRegistry;
  const skipped = entryHintSkipped();
  if (!skipped) return await registry.claimSessionHint(task.token, operation, task.sourceApplication).catch(() => false) || null;
  return await registry.sessionHintAvailable(task.token, operation, task.sourceApplication).catch(() => false) ? skipped : null;
}
