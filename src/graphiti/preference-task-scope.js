// Legacy read compatibility recognizes only an anchored restrictive session
// clause. Provenance, keywords and unknown prose remain visible. No stored
// record is rewritten; canonical qualifiers take precedence.
export function legacyPreferenceSession(instruction) {
  return typeof instruction === 'string'
    ? /^仅(?:在|适用于)\s*(?:Codex|Claude Code|Cursor)\s*会话\s+([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})\s*(?:中|的|后续|[，,：:])/.exec(instruction)?.[1]
    : undefined;
}

export function preferenceAppliesToTask(item, context = {}) {
  const qualifiers = { ...item.attributes, ...item.attributes?.preference_qualifiers, ...item.preference_qualifiers };
  const sessionId = context.sessionId ?? context.sourceSessionId;
  const hasSessionCondition = ['sessionId', 'session_id', 'sessionIds', 'session_ids']
    .some(key => Object.hasOwn(qualifiers, key));
  const tests = [
    [qualifiers.sessionId ?? qualifiers.session_id ?? qualifiers.sessionIds ?? qualifiers.session_ids
      ?? (hasSessionCondition ? null : legacyPreferenceSession(item.instruction)), sessionId],
    [qualifiers.workKind ?? qualifiers.work_kind ?? qualifiers.workKinds ?? qualifiers.work_kinds, context.workKind],
    [qualifiers.workflow ?? qualifiers.workflows, context.workflow],
  ];
  return tests.every(([condition, actual]) => {
    const values = typeof condition === 'string' && condition.trim() ? [condition]
      : Array.isArray(condition) && condition.length && condition.every(value => typeof value === 'string' && value.trim()) ? condition : null;
    return !values || !actual || values.includes(actual);
  });
}
