import { EVERY_SCENE, generalItemExcluded, tasteDomainScenes } from './task-scene.js';

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

// How one preference meets the task (rec#15 D-27; the Provider's copy is
// graph-provider/fuli_graph/preference_task_scope.py):
// - Every dimension the item states must hold (AND); a list within one
//   dimension is any of its values (OR). The dimensions are session, work_kind,
//   workflow and the tasteDomain scene key, which task-scene.js maps to work
//   kinds, so a workKind qualifier and a tasteDomain on one item must both
//   name the task's work kind.
// - A definite mismatch in any dimension excludes the item, even if another
//   dimension is unknown. A domain outside the scene table never matches.
// - Otherwise a stated dimension the task does not supply fails closed:
//   scope_unknown, which is not applied and is listed by key only.
// - An item with no scene key follows the general rule in task-scene.js.
export function preferenceTaskApplicability(item, context = {}) {
  const qualifiers = { ...item.attributes, ...item.attributes?.preference_qualifiers, ...item.preference_qualifiers };
  const stated = taskScopeConditions(item, qualifiers, context).filter(({ values }) => values);
  const conditions = stated.filter(({ values }) => values !== EVERY_SCENE);
  if (conditions.some(({ values, actual }) => !values.length || (actual && !values.includes(actual)))) return 'excluded';
  if (!stated.some(({ scene }) => scene) && generalItemExcluded(qualifiers, context.workKind)) return 'excluded';
  return conditions.some(({ actual }) => !actual) ? 'scope_unknown' : 'applies';
}

export function preferenceAppliesToTask(item, context = {}) {
  return preferenceTaskApplicability(item, context) === 'applies';
}

function taskScopeConditions(item, qualifiers, context) {
  const hasSessionCondition = ['sessionId', 'session_id', 'sessionIds', 'session_ids']
    .some(key => Object.hasOwn(qualifiers, key));
  return [
    { values: conditionValues(qualifiers.sessionId ?? qualifiers.session_id ?? qualifiers.sessionIds ?? qualifiers.session_ids
      ?? (hasSessionCondition ? null : legacyPreferenceSession(item.instruction))), actual: preferenceTaskSession(context) },
    { values: conditionValues(qualifiers.workKind ?? qualifiers.work_kind ?? qualifiers.workKinds ?? qualifiers.work_kinds),
      actual: context.workKind, scene: true },
    { values: conditionValues(qualifiers.workflow ?? qualifiers.workflows), actual: context.workflow },
    { values: tasteDomainScenes(qualifiers) ?? null, actual: context.workKind, scene: true }
  ];
}

function conditionValues(condition) {
  return typeof condition === 'string' && condition.trim() ? [condition]
    : Array.isArray(condition) && condition.length && condition.every(value => typeof value === 'string' && value.trim()) ? condition : null;
}
