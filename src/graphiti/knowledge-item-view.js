// Agent-facing view of a knowledge item. Search and recall results carry
// governance and ranking metadata that is almost always at its default; it is
// omitted only while it holds exactly that default, so any edited, reviewed,
// used, flagged or inherited state stays visible. Two redundant identifiers are
// the only exceptions: group_id (the Provider's internal partition, never a tool
// argument) and a personal item's space id (the requested space). Management
// reads keep the complete record.
const EMPTY = (value) => value === null || value === undefined;
const NONE = (value) => Array.isArray(value) && !value.length;
const REDUNDANT = new Set(['group_id']);
const ITEM_DEFAULTS = {
  reasoning_summary: EMPTY,
  preference_project_id: EMPTY,
  preference_agent_id: EMPTY,
  defined_project_id: EMPTY,
  project_agent_id: EMPTY,
  inheritance_mode: (value) => value === 'local_only',
  inherited_project_ids: NONE,
  inherited_from_project_id: EMPTY,
  scope_distance: (value) => value === 0,
  scope_path: NONE,
  human_edited: (value) => value === false,
  human_change_status: (value) => value === 'none',
  human_change_version: (value) => value === 0,
  last_human_changed_at: EMPTY,
  last_agent_viewed_at: EMPTY,
  last_agent_reviewed_at: EMPTY,
  utility_score: (value) => value === 0,
  qualified_use_count: (value) => value === 0,
  distinct_task_count: (value) => value === 0,
  last_used_at: EMPTY,
  negative_evidence_count: (value) => value === 0,
  requires_attention: (value) => value === false,
  last_feedback_kind: EMPTY,
  last_feedback_at: EMPTY,
  source_uris: NONE,
  providerUrl: EMPTY
};

export const KNOWLEDGE_ITEM_DEFAULTS_NOTE = 'Omitted item fields are at their defaults: local_only and not inherited, '
  + 'not human-edited or reviewed, no recorded use or negative feedback, not flagged for attention, no source URIs; '
  + 'personal items belong to the requested space; the internal group_id is omitted.';

export function compactKnowledgeItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const view = {};
  for (const [key, value] of Object.entries(item)) {
    if (REDUNDANT.has(key) || ITEM_DEFAULTS[key]?.(value)) continue;
    if ((key === 'space_id' || key === 'spaceId') && item.scope === 'personal') continue;
    view[key] = value;
  }
  if (view.confirmation_basis?.agent_policy_version === null) {
    const { agent_policy_version: _omitted, ...basis } = view.confirmation_basis;
    view.confirmation_basis = basis;
  }
  return view;
}

export function compactKnowledgeItems(items) {
  return Array.isArray(items) ? items.map(compactKnowledgeItem) : items;
}
