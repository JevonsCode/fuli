const SUMMARY_PREVIEW = 800;
const NOTE_COUNT_PREVIEW = 3;
const NOTE_PREVIEW = 160;

// Preserve every effective instruction; remove evidence envelopes from the hot
// path. Full records remain available through explicit read tools.
export function compactTaskContext(value) {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  const recovery = value.conversation?.recovery;
  if (recovery) result.conversation = { ...value.conversation, recovery: { ...recovery,
    messages: undefined,
    messagesOmitted: Boolean(recovery.messages?.length),
    view: 'preview',
    guidance: 'Historical messages are on demand. Read read_agent_conversation using recovered_from (or conversation_id when absent) before relying on omitted history; latest_checkpoint is the current saved result.'
  } };
  const retrieval = value.application_guidance?.knowledge_retrieval;
  if (retrieval && JSON.stringify(retrieval) === JSON.stringify(value.task_knowledge_recall?.guidance)) {
    result.task_knowledge_recall = { ...value.task_knowledge_recall, guidance: undefined,
      guidance_ref: 'application_guidance.knowledge_retrieval' };
  }
  if (Array.isArray(value.effective_preferences)) result.effective_preferences = value.effective_preferences.map(item => ({
    instruction: item.instruction, preference_key: item.preference_key,
    preference_scope: item.preference_scope, confirmation_status: item.confirmation_status,
    profile_aspect: item.profile_aspect,
    ...Object.fromEntries(['preference_project_id', 'preference_agent_id',
      'inherited_from_project_id', 'scope_distance', 'scope_path', 'inheritance_mode', 'inherited_project_ids']
      .filter(key => item[key] !== undefined).map(key => [key, item[key]])),
    ...(item.preference_qualifiers || item.attributes ? {
      preference_qualifiers: instructionQualifiers({ ...item.attributes,
        ...item.attributes?.preference_qualifiers, ...item.preference_qualifiers }, item.instruction)
    } : {}),
    ...(item.attributes?.tasteDomain ? { attributes: { tasteDomain: item.attributes.tasteDomain } } : {})
  }));
  if (value.project_management_context?.managers) result.project_management_context = {
    ...value.project_management_context,
    managers: value.project_management_context.managers.map(manager => ({ ...manager,
      board: manager.board && { version: manager.board.version, total: manager.board.total,
        view: 'on_demand', guidance: 'Discover and call the manager read_board tool before matching, creating or updating a work item; this entry omits board details.' }
    }))
  };
  const continuity = value.project_agent_context;
  if (continuity) result.project_agent_context = { ...continuity, team: undefined, recent_tasks: undefined,
    ...(continuity.team?.guidance ? { team_guidance: continuity.team.guidance } : {}),
    details_guidance: 'Read get_project_team for staffing and list_project_agent_tasks for task history when needed.' };
  if (continuity?.memory || continuity?.global_memory) {
    result.project_agent_context = { ...result.project_agent_context, knowledge: undefined,
      memory: continuity.memory && memoryPreview(continuity.memory,
        'Use get_project_agent_memory before merging or checkpointing working memory; this preview omits history and may truncate notes.'),
      ...(continuity.global_memory !== undefined ? { global_memory: continuity.global_memory && memoryPreview(continuity.global_memory,
        'Global layer of the same employee. Read get_project_agent_memory with personalProjectId: null before merging or checkpointing it; this preview omits history and may truncate notes.') } : {}) };
  }
  return result;
}

function instructionQualifiers(attributes, instruction) {
  return Object.fromEntries(Object.entries(attributes).filter(([key, value]) =>
    !['preferenceKey', 'preference_key', 'preference_qualifiers', 'searchTerms', 'search_terms', 'weight'].includes(key)
      && !(key === 'instruction' && value === instruction)));
}

// Each layer has a fixed preview size, so adding the global layer cannot grow
// the hot path without bound. notesTruncated reports this view's own cuts.
function memoryPreview(memory, guidance) {
  const current = memory.current;
  const notes = current?.memory;
  let notesTruncated = false;
  const text = (value, limit) => {
    if (typeof value === 'string' && value.length > limit) notesTruncated = true;
    return value?.slice(0, limit);
  };
  const list = values => {
    if (Array.isArray(values) && values.length > NOTE_COUNT_PREVIEW) notesTruncated = true;
    return values?.slice(0, NOTE_COUNT_PREVIEW).map(note => text(note, NOTE_PREVIEW));
  };
  const preview = notes && {
    summary: text(notes.summary, SUMMARY_PREVIEW),
    decisions: list(notes.decisions),
    openThreads: list(notes.openThreads),
    nextActions: list(notes.nextActions)
  };
  return { ...memory, history: undefined, workLog: undefined,
    current: current && { ...current, memory: preview },
    view: 'preview', notesTruncated, requiresFullReadBeforeWrite: true, guidance };
}
