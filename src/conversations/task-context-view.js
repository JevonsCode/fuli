// Preserve every effective instruction; remove evidence envelopes from the hot
// path. Full records remain available through explicit read tools.
export function compactTaskContext(value) {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  if (Array.isArray(value.effective_preferences)) result.effective_preferences = value.effective_preferences.map(item => ({
    instruction: item.instruction, preference_key: item.preference_key,
    preference_scope: item.preference_scope, confirmation_status: item.confirmation_status
  }));
  const continuity = value.project_agent_context;
  if (continuity?.memory) {
    const memory = continuity.memory;
    const current = memory.current;
    const notes = current?.memory;
    result.project_agent_context = { ...continuity, knowledge: undefined, recent_tasks: undefined,
      memory: { ...memory, history: undefined, workLog: undefined,
        current: current && { ...current, memory: notes && {
          summary: notes.summary?.slice(0, 800),
          decisions: notes.decisions?.slice(0, 3).map(note => note.slice(0, 160)),
          openThreads: notes.openThreads?.slice(0, 3).map(note => note.slice(0, 160)),
          nextActions: notes.nextActions?.slice(0, 3).map(note => note.slice(0, 160))
        } },
        view: 'preview', requiresFullReadBeforeWrite: true,
        guidance: 'Use get_project_agent_memory before merging or checkpointing working memory; this preview omits history and may truncate notes.'
      } };
  }
  return result;
}
