import { isDeepStrictEqual } from 'node:util';
import { containsEntryRules, DETAILS_GUIDANCE, ENTRY_RULES_URI, entryRules, entryRulesReference, ruleTextView } from './entry-rules.js';
import { preferenceScopeGuidance } from '../graphiti/collaboration-preference-workflow.js';
import { copyPreferenceScope } from './preference-snapshot.js';
import { preferenceInstructionView } from './preference-view.js';

const SUMMARY_PREVIEW = 800;
const NOTE_COUNT_PREVIEW = 3;
const NOTE_PREVIEW = 160;
const ROSTER_PREVIEW = 4;
const DRAFT_LABEL_BUDGET = 32;

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
  if (share && result.task_knowledge_recall) result.task_knowledge_recall = recallView(result.task_knowledge_recall);
  // Off-flags of a fresh task: a resumed or orphaned checkpoint says so.
  if (share && value.resumed_checkpoint === false) delete result.resumed_checkpoint;
  if (share && value.previous_checkpoint_missing === false) delete result.previous_checkpoint_missing;
  // Task-independent rule text is referenced, not repeated on every turn.
  if (share && containsEntryRules(value.task_guidance, 'task_guidance')
    && Object.keys(value.task_guidance).length === Object.keys(entryRules().sections.task_guidance).length) {
    result.task_guidance = entryRulesReference('task_guidance');
  }
  if (sharedApplication) {
    const shared = entryRules().sections.application_guidance;
    // The scope lines are a template over the IDs already in context.
    const scope = preferenceScopeGuidance(value.context?.personal_project_id ?? null, value.context?.project_agent_id ?? null);
    const templated = Object.entries(scope).every(([key, text]) => value.application_guidance[key] === text);
    result.application_guidance = { ...Object.fromEntries(Object.entries(value.application_guidance)
      .filter(([key]) => !Object.hasOwn(shared, key) && !(templated && Object.hasOwn(scope, key)))),
    ...entryRulesReference('application_guidance'),
    ...(templated ? { scope_rules: entryRulesReference('scope_guidance').rules } : {}) };
  }
  if (share && value.checkpoint_guidance) result.checkpoint_guidance = ruleTextView(value.checkpoint_guidance, 'checkpoint_guidance');
  if (share && value.context) result.context = withoutDefaults(value.context, { counts: true, flags: true });
  if (value.conversation) result.conversation = conversationView(value.conversation, share);
  if (share && value.agent_receipt) result.agent_receipt = receiptView(value.agent_receipt);
  else if (value.agent_receipt?.continuation) result.agent_receipt = { ...value.agent_receipt,
    continuation: { ...value.agent_receipt.continuation,
      guidance: text(value.agent_receipt.continuation.guidance, 'continuation_guidance') } };
  if (Array.isArray(value.effective_preferences)) result.effective_preferences = value.effective_preferences.map(preferenceInstructionView);
  if (value.project_management_context?.managers) result.project_management_context = managementContextView(
    value.project_management_context, guidance => text(guidance, 'manager_guidance'));
  const continuity = value.project_agent_context;
  const management = value.project_management_context;
  const omitTeam = !value.worker_run && Object.hasOwn(value, 'project_management_context')
    && (management?.status === 'degraded' || !management?.managers?.length);
  if (omitTeam) delete result.judgment_context;
  else if (value.judgment_context?.guidance) result.judgment_context = { ...value.judgment_context,
    guidance: text(value.judgment_context.guidance, 'judgment_guidance') };
  const teamRules = !omitTeam && (continuity?.team?.guidance ?? continuity?.team_guidance);
  const teamGuidance = teamRules ? text(teamRules, 'team_guidance') : undefined;
  if (continuity) result.project_agent_context = { ...continuity, ...selectionView(continuity, share),
    ...(share && continuity.directorySnapshot ? { directorySnapshot: snapshotView(continuity.directorySnapshot) } : {}),
    team: omitTeam ? undefined : compactTeamRoster(continuity.team, teamGuidance),
    team_guidance: undefined,
    recent_tasks: undefined,
    guidance: text(continuity.guidance, 'continuity_guidance'),
    ...(teamGuidance ? { team_guidance: teamGuidance } : {}),
    details_guidance: text(DETAILS_GUIDANCE, 'details_guidance') };
  if (continuity?.memory || continuity?.global_memory) {
    result.project_agent_context = { ...result.project_agent_context, knowledge: undefined,
      memory: continuity.memory && memoryPreview(continuity.memory, ruleOrReference('memory_guidance', share)),
      ...(continuity.global_memory !== undefined ? { global_memory: continuity.global_memory
        && memoryPreview(continuity.global_memory, ruleOrReference('global_memory_guidance', share)) } : {}) };
  }
  if (share && result.project_agent_context) result.project_agent_context = withoutDefaults(result.project_agent_context,
    { flags: false, keep: AGENT_CONTEXT_STATES });
  return copyPreferenceScope(value, share ? withRulesVersion(result) : result);
}

// Every shared rule reference names the same rules version, so an entry with
// two or more states it once as rules_version (one costs less than the field).
// Preferences, recovered history and recalled items are data, never rule
// references, and are passed through untouched.
const RULELESS_FIELDS = new Set(['effective_preferences', 'recovery', 'facts', 'entities', 'knowledge_index']);
function withRulesVersion(entry) {
  const { version } = entryRules();
  const isReference = item => item.version === version && typeof item.rules === 'string'
    && item.rules.startsWith(`${ENTRY_RULES_URI}/`);
  let count = 0;
  const view = (item, strip) => {
    if (Array.isArray(item)) return item.map(value => view(value, strip));
    if (!item || typeof item !== 'object') return item;
    const reference = isReference(item);
    if (reference) count++;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !(strip && reference && key === 'version'))
      .map(([key, value]) => [key, RULELESS_FIELDS.has(key) ? value : view(value, strip)]));
  };
  view(entry, false);
  return count > 1 ? { ...view(entry, true), rules_version: version } : entry;
}

// Each manager's routing, title policy and tools; the board itself is read on
// demand through the manager's own read_board tool, as its routing rules say.
// `guidance` gives those rules as this entry delivers them (a task entry
// references them). The receipt of the entry's own board read names no work
// the Agent did, so the view leaves it out.
export function managementContextView(management, guidance) {
  return { ...management,
    managers: management.managers.map(({ collaboration_receipt: _receipt, ...manager }) => ({ ...manager,
      ...(manager.guidance ? { guidance: guidance(manager.guidance) } : {}),
      board: manager.board && { version: manager.board.version, total: manager.board.total, view: 'on_demand' }
    }))
  };
}

// The entry receipt only has to be copied: the markdown plus the shared rule.
// Owner details and the hand-off prompt stay on the checkpoint receipt.
export function receiptView(receipt) {
  return withoutDefaults({ required: receipt.required, markdown: receipt.markdown,
    collaborators: receipt.collaborators, work_status: receipt.work_status, persistence: receipt.persistence,
    guidance: ruleTextView(receipt.guidance, 'receipt_guidance') }, { flags: true });
}

// null memory means that layer is unavailable and an empty team means no
// members, so these keys stay even when empty.
const AGENT_CONTEXT_STATES = new Set(['memory', 'global_memory', 'team']);

// Empty values are defaults; omitting them changes nothing a reader can act on.
// Zero and false are pruned only where they are counts and off-flags: a memory
// revision of 0 is still the next expectedRevision.
function withoutDefaults(value, { keep = new Set(), ...options } = {}) {
  if (Array.isArray(value)) return value.map(item => withoutDefaults(item, options)).filter(item => !isDefault(item, options));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, keep.has(key) ? item : withoutDefaults(item, options)])
    .filter(([key, item]) => keep.has(key) || !isDefault(item, options)));
}

function isDefault(value, { counts = false, flags = false } = {}) {
  return value === undefined || value === null || (flags && value === false) || (counts && value === 0) || value === ''
    || (Array.isArray(value) && !value.length) || (typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.keys(value).length);
}

// The Provider's whole budgeted window is kept here. What one native session
// has already seen is left out only at delivery, against that session's own
// transcript (recent-context.js); a client without one receives it all.
// A conversation with nothing to recover leaves out its null recovery fields.
function conversationView(conversation, share) {
  if (!share) return conversation;
  const unused = new Map([['recovery', null], ['recovered_from', null], ['compacted', false]]);
  return { ...Object.fromEntries(Object.entries(conversation).filter(([key, item]) => !unused.has(key) || unused.get(key) !== item)),
    guidance: ruleTextView(conversation.guidance, 'conversation_guidance') };
}

// A recall that matched nothing has one marker to show, so a sourceMarker that
// repeats noMatchSourceMarker byte for byte is left out; so are a complete
// search's zero failures and an unmatched prompt's empty categories.
function recallView(recall) {
  const repeated = recall.sourceMarker && isDeepStrictEqual(recall.sourceMarker, recall.noMatchSourceMarker);
  return Object.fromEntries(Object.entries(recall).filter(([key, item]) => !(key === 'sourceMarker' && repeated)
    && !(key === 'partial' && item === false) && !(key === 'failed_query_count' && item === 0)
    && !(key === 'trigger_categories' && Array.isArray(item) && !item.length)));
}

// When the selected lead also executes, the execution pair repeats the
// selection and match_basis only explains it; any other execution decision
// keeps both, since its match_basis then says how to staff the work.
function selectionView(continuity, share) {
  const selfExecuting = share && typeof continuity.execution_reason === 'string'
    && continuity.execution_agent_id === continuity.project_agent_id
    && continuity.execution_reason === continuity.selection_reason;
  return selfExecuting ? { match_basis: undefined, execution_reason: undefined, execution_agent_id: undefined } : {};
}

// A snapshot whose files are all as the Agent's folder already holds them
// says only where the folder is and how many files it holds.
function snapshotView(snapshot) {
  if (!Array.isArray(snapshot.files) || !snapshot.files.length
    || snapshot.files.some(file => file.state !== 'unchanged')) return snapshot;
  const { files, ...rest } = snapshot;
  return { ...rest, files_unchanged: files.length };
}

function ruleOrReference(section, share) {
  return share ? entryRulesReference(section) : entryRules().sections[section];
}

// Each layer has a fixed preview size, so adding the global layer cannot grow
// the hot path without bound. notesTruncated reports this view's own cuts.
function memoryPreview(memory, guidance) {
  const current = memory.current;
  // A layer never written has nothing to preview, cut or read in full first:
  // its scope, revision 0 (the first write's expectedRevision) and rules.
  if (!current && memory.revision === 0 && !memory.scrubbedGuidance) return { scope: memory.scope, revision: 0, current: null, guidance };
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
  // Space, project and Agent IDs are already in the entry context, and the
  // record's revision is the layer's (scopedAgentMemoryView checks both). Its
  // checkpoint, task and session IDs are provenance the full read returns.
  const { personalSpaceId: _space, personalProjectId: _project, agentId: _agent, revision: _revision,
    checkpointId: _checkpoint, taskId: _task, sourceSessionId: _session, ...record } = current ?? {};
  return { ...memory, history: undefined, workLog: undefined, personalSpaceId: undefined,
    personalProjectId: undefined, agentId: undefined, storage: undefined,
    current: current && { ...record, memory: preview },
    view: 'preview', notesTruncated, requiresFullReadBeforeWrite: true, guidance };
}

// Staff detail is query-on-demand. Bound the entry and dedupe identities before
// removing IDs; same-name people remain distinct.
function compactTeamRoster(team, deliveredGuidance) {
  if (!team) return undefined;
  const people = [...(team.roster ?? []), ...(team.assigned_collaborators ?? []), ...(team.assigned_peers ?? [])];
  const roster = [...new Map(people.map(person => [person.agent_id ?? person, person])).values()];
  const view = count => ({ roster: roster.slice(0, count).map(person => ({ name: person.name, occupation: person.occupation ?? null })),
    ...(roster.length > count ? { roster_total: roster.length, roster_truncated: true } : {}) });
  let count = Math.min(roster.length, ROSTER_PREVIEW);
  // Once the team rules are a reference, the roster may spend only the bytes
  // that rule text no longer costs, keeping room for the draft marker.
  if (team.guidance && deliveredGuidance !== team.guidance) {
    const budget = Buffer.byteLength(JSON.stringify({ team_guidance: team.guidance })) - DRAFT_LABEL_BUDGET;
    while (count && Buffer.byteLength(JSON.stringify({ team: view(count), team_guidance: deliveredGuidance })) > budget) count--;
  }
  return view(count);

}
