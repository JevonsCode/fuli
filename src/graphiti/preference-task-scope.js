// Legacy read compatibility recognizes only an anchored restrictive session
// clause. Provenance, keywords and unknown prose remain visible. No stored
// record is rewritten; canonical qualifiers take precedence.
export function legacyPreferenceSession(instruction) {
  return typeof instruction === 'string'
    ? /^仅(?:在|适用于)\s*(?:Codex|Claude Code|Cursor)\s*会话\s+([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})\s*(?:中|的|后续|[，,：:])/.exec(instruction)?.[1]
    : undefined;
}

// A generated MCP process identity does not identify the user's conversation.
export function preferenceTaskSession(context = {}) {
  return context.sessionId ?? (context.sourceSessionId?.startsWith('fuli-host-')
    ? undefined : context.sourceSessionId);
}

export function preferenceAppliesToTask(item, context = {}) {
  return taskScopeConditions(item, context).every(({ values, actual }) => !values || !actual || values.includes(actual));
}

// Dimensions a preference is limited to but the task did not state. Such a
// rule is neither applicable nor excluded: its scope is unknown for this task.
export function preferenceUnknownTaskDimensions(item, context = {}) {
  return taskScopeConditions(item, context).filter(({ values, actual }) => values && !actual)
    .map(({ dimension }) => dimension);
}

function taskScopeConditions(item, context) {
  const qualifiers = { ...item.attributes, ...item.attributes?.preference_qualifiers, ...item.preference_qualifiers };
  const hasSessionCondition = ['sessionId', 'session_id', 'sessionIds', 'session_ids']
    .some(key => Object.hasOwn(qualifiers, key));
  return [
    ['session', qualifiers.sessionId ?? qualifiers.session_id ?? qualifiers.sessionIds ?? qualifiers.session_ids
      ?? (hasSessionCondition ? null : legacyPreferenceSession(item.instruction)), preferenceTaskSession(context)],
    ['work_kind', qualifiers.workKind ?? qualifiers.work_kind ?? qualifiers.workKinds ?? qualifiers.work_kinds, context.workKind],
    ['workflow', qualifiers.workflow ?? qualifiers.workflows, context.workflow],
  ].map(([dimension, condition, actual]) => ({ dimension, values: conditionValues(condition), actual }));
}

function conditionValues(condition) {
  return typeof condition === 'string' && condition.trim() ? [condition]
    : Array.isArray(condition) && condition.length && condition.every(value => typeof value === 'string' && value.trim()) ? condition : null;
}
