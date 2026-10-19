import { projectAgentCollaborationPreferences } from '../graphiti/collaboration-preference-workflow.js';
import { preferenceTaskSession, preferenceUnknownTaskDimensions } from '../graphiti/preference-task-scope.js';

// The preference context Tonborg judges with is the task-entry receipt, made
// compact. Change this version whenever its shape changes, so a judgment made
// with an older context is never reused as if it were equivalent.
export const PREFERENCE_RECEIPT_VERSION = 'preference-receipt-1';
export const PREFERENCE_RECEIPT_RULES = 'Preferences: apply only preferences.selected. A scope_unknown rule is limited to a task dimension this request does not state: do not apply it, do not treat it as absent, and escalate if it could change this decision; it may replace a broader rule with the same key. Apply no side of a conflict; escalate if a conflict is relevant. A rule that is not listed is not permission.';
const SOURCE_WINDOWS = { candidates_truncated: 'candidates', project_ancestors_truncated: 'project_ancestors',
  queued_conflicts_truncated: 'queued_conflicts' };

export async function readJudgmentPreferences(app, { personalProjectId, projectAgentId = null, taskScope = {} }) {
  const scope = { work_kind: taskScope.workKind ?? 'unknown', workflow: taskScope.workflow ?? 'unknown',
    session: preferenceTaskSession(taskScope) ? 'known' : 'unknown' };
  let raw;
  try {
    raw = await app.getCollaborationPreferences({ personalProjectId, ...(projectAgentId ? { projectAgentId } : {}),
      sessionId: taskScope.sessionId ?? null, sourceSessionId: taskScope.sourceSessionId ?? null,
      workKind: taskScope.workKind ?? null, workflow: taskScope.workflow ?? null });
  } catch (error) {
    return { status: 'unavailable', scope, reason: error.code ?? 'preference_read_failed' };
  }
  // An answer without its preference list is a failed read, never "no preferences".
  if (!Array.isArray(raw?.effective_preferences)) return { status: 'unavailable', scope, reason: 'preference_receipt_invalid' };
  const receipt = projectAgentCollaborationPreferences(raw, { personalProjectId }, { projectAgentId, taskScope });
  const truncated = Object.entries(receipt.context.source_windows).filter(([, value]) => value !== false)
    .map(([window]) => SOURCE_WINDOWS[window]);
  if (receipt.context.source_truncated && !truncated.length) truncated.push('source');
  // IDs, short rule text and flags only; bodies, reasoning and evidence stay in FULI.
  const rule = item => {
    const needs = preferenceUnknownTaskDimensions(item, taskScope);
    return { rule: item.instruction, authority: item.confirmation_status,
      ...(item.inherited_from_project_id ? { from: item.inherited_from_project_id } : {}), ...(needs.length ? { needs } : {}) };
  };
  const effective = receipt.effective_preferences.map(item => ({ key: item.preference_key, scope: item.preference_scope, ...rule(item) }));
  return { status: truncated.length ? 'partial' : 'complete', scope,
    selected: effective.filter(item => !item.needs), scope_unknown: effective.filter(item => item.needs),
    conflicts: receipt.active_conflicts.map(conflict => ({ key: conflict.preference_key, scope: conflict.preference_scope,
      alternatives: conflict.alternatives.map(rule) })),
    omitted: { out_of_task_scope: receipt.context.task_scope_excluded_count, truncated } };
}

// Like a blocked task entry, an incomplete receipt pauses the decision: a
// relevant rule may be missing, so Tonborg neither approves nor recommends.
export function preferenceHold(receipt) {
  if (receipt.status === 'complete') return null;
  return receipt.status === 'unavailable'
    ? { error: 'preferences_unavailable', evidence: ['preference_delivery:unavailable'],
      summary: 'Tonborg could not read the scoped preferences, so it did not approve. Ask again once preferences can be read.' }
    : { error: 'preferences_incomplete', evidence: ['preference_delivery:partial'],
      summary: `Only part of the scoped preferences was delivered (${receipt.omitted.truncated.join(', ')} truncated). Tonborg does not approve while a relevant rule may be missing.` };
}

// What a judgment record keeps about its preference context: state, not rule text.
export function preferenceDeliveryRecord(receipt) {
  return { version: PREFERENCE_RECEIPT_VERSION, status: receipt.status, scope: receipt.scope,
    ...(receipt.status === 'unavailable' ? { reason: receipt.reason } : { selected: receipt.selected.length,
      scopeUnknown: receipt.scope_unknown.map(item => item.key), conflicts: receipt.conflicts.map(item => item.key),
      truncated: receipt.omitted.truncated }) };
}
