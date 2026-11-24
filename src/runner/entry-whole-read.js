import { joinTaskPreferencePages } from '../graphiti/task-preference-pages.js';
import { entrySet, entryToken, envelope, isWholeEntry, resultValue, wholePreferencesKey } from './offline-calls.js';

// The host's code for a page read whose revision changed or whose cursor expired (task-preference-pages.js).
const CURSOR_INVALID = 'preference_cursor_invalid';

// The rest of a task entry the host could not deliver whole (isWholeEntry),
// read with the host's own reader in the session that entered the task (the
// reader binds it), its pages joined in one revision as the host joins them
// (joinTaskPreferencePages), and kept for that entry's set
// (wholePreferencesKey): Tonborg's judgment on this runner reads it
// (projectPreferences), and so does a read while the host is away
// (offline-calls.js). A set already kept is not read again: an MCP entry names
// its set by preferences_revision, the same for every later entry of the
// conversation until a preference, the scene or the session changes. A
// revision that changed between pages starts the read over, once. Nothing is
// kept unless the read is whole. read(input): read_task_preferences' answer.
// Says 'not_needed', 'kept', 'whole' or 'not_whole'; a failed read throws.
export async function keepWholeEntry(store, answer, read) {
  const value = resultValue(answer);
  const token = entryToken(value);
  const scope = { personalSpaceId: value?.context?.personal_space_id, personalProjectId: value?.context?.personal_project_id };
  if (isWholeEntry(value) || !token || !scope.personalSpaceId || !scope.personalProjectId) return 'not_needed';
  const key = wholePreferencesKey({ ...scope, set: entrySet(value) });
  if (store.answer(key)) return 'kept';
  const readAll = () => joinTaskPreferencePages((cursor) => read({ taskContextToken: token, ...(cursor ? { cursor } : {}) }));
  let rest;
  try {
    rest = await readAll();
  } catch (error) {
    if (error?.code !== CURSOR_INVALID) throw error;
    rest = await readAll();
  }
  if (!isWholeEntry(rest)) return 'not_whole';
  store.rememberAnswer(key, 'read_task_preferences', envelope({
    effective_preferences: rest.effective_preferences, active_conflicts: rest.active_conflicts ?? [],
    scope_unknown: rest.scope_unknown ?? [], context: rest.context ?? value.context }));
  return 'whole';
}
