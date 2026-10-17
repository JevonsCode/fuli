import { containsEntryRules, entryRules, entryRulesReference, ruleTextView } from './entry-rules.js';

const SUMMARY_PREVIEW = 800;
const NOTE_COUNT_PREVIEW = 3;
const NOTE_PREVIEW = 160;

// Preserve every effective instruction and Provider-budgeted conversation raw
// window. Other evidence envelopes remain available through explicit read tools.
export function compactTaskContext(value) {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  // Sealed workers cannot read MCP resources, so their entry keeps full rule text.
  const share = !value.worker_run;
  const text = (current, section) => share ? ruleTextView(current, section) : current;
  const sharedApplication = share && containsEntryRules(value.application_guidance, 'application_guidance');
  const retrieval = value.application_guidance?.knowledge_retrieval;
  if (retrieval && JSON.stringify(retrieval) === JSON.stringify(value.task_knowledge_recall?.guidance)) {
    result.task_knowledge_recall = { ...value.task_knowledge_recall, guidance: undefined,
      guidance_ref: sharedApplication ? entryRulesReference('application_guidance').rules
        : 'application_guidance.knowledge_retrieval' };
  }
  // Task-independent rule text is referenced, not repeated on every turn.
  if (share && containsEntryRules(value.task_guidance, 'task_guidance')
    && Object.keys(value.task_guidance).length === Object.keys(entryRules().sections.task_guidance).length) {
    result.task_guidance = entryRulesReference('task_guidance');
  }
  if (sharedApplication) {
    const shared = entryRules().sections.application_guidance;
    result.application_guidance = { ...Object.fromEntries(Object.entries(value.application_guidance)
      .filter(([key]) => !Object.hasOwn(shared, key))), ...entryRulesReference('application_guidance') };
  }
  if (value.conversation) result.conversation = conversationView(value.conversation, share);
  if (value.agent_receipt?.continuation) result.agent_receipt = { ...value.agent_receipt,
    continuation: { ...value.agent_receipt.continuation,
      guidance: text(value.agent_receipt.continuation.guidance, 'continuation_guidance') } };
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
    guidance: text(continuity.guidance, 'continuity_guidance'),
    ...(continuity.team?.guidance ?? continuity.team_guidance ? {
      team_guidance: text(continuity.team?.guidance ?? continuity.team_guidance, 'team_guidance') } : {}),
    details_guidance: 'Read get_project_team for staffing and list_project_agent_tasks for task history when needed.' };
  if (continuity?.memory || continuity?.global_memory) {
    result.project_agent_context = { ...result.project_agent_context, knowledge: undefined,
      memory: continuity.memory && memoryPreview(continuity.memory, ruleOrReference('memory_guidance', share)),
      ...(continuity.global_memory !== undefined ? { global_memory: continuity.global_memory
        && memoryPreview(continuity.global_memory, ruleOrReference('global_memory_guidance', share)) } : {}) };
  }
  return result;
}

// Inside the same native chat the host already holds the recent messages, so
// only the latest saved result is repeated; another chat gets the full window.
function conversationView(conversation, share) {
  if (!share) return conversation;
  const view = { ...conversation, guidance: ruleTextView(conversation.guidance, 'conversation_guidance') };
  const recovery = conversation.recovery;
  if (conversation.same_session && recovery && Array.isArray(recovery.messages)) {
    view.recovery = { conversation_id: recovery.conversation_id, revision: recovery.revision,
      latest_checkpoint: recovery.latest_checkpoint ?? null, summary_role: recovery.summary_role,
      messages_omitted: recovery.messages.length, omitted_reason: 'same_host_session' };
  }
  return view;
}

function ruleOrReference(section, share) {
  return share ? entryRulesReference(section) : entryRules().sections[section];
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
  // Space, project and Agent IDs are already in the entry context.
  return { ...memory, history: undefined, workLog: undefined, personalSpaceId: undefined,
    personalProjectId: undefined, agentId: undefined, storage: undefined,
    current: current && { ...current, memory: preview },
    view: 'preview', notesTruncated, requiresFullReadBeforeWrite: true, guidance };
}
