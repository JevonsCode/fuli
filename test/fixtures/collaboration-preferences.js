// A preference answer whose every Provider source window was read in full.
export function completePreferences({ effective = [], ...rest } = {}) {
  return { effective_preferences: effective, global_preferences: effective, conflicts: [], queued_conflicts: [],
    source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false },
    truncated: false, ...rest };
}
