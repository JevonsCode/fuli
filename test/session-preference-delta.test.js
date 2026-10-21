import assert from 'node:assert/strict';
import test from 'node:test';
import { preferenceSnapshot, projectPreferenceDelta, withPreferenceScope } from '../src/conversations/preference-snapshot.js';

const scope = { personal_space_id: 'space', personal_project_id: 'project', project_agent_id: 'lead',
  source_application: 'codex', session_id: 'native-session',
  preference_scope: { version: 1, work_kind: 'implementation', workflow: null } };
function entry(token = 'task-a', changes = {}) {
  return withPreferenceScope({ taskContextToken: token, task_context_token: token, checkpoint_required: true,
    effective_preferences: Array.from({ length: 20 }, (_, i) => ({ preference_key: `rule-${i}`,
      preference_scope: 'project', preference_project_id: 'project', confirmation_status: 'confirmed',
      instruction: `Synthetic instruction ${i}: ${'Keep the current boundary. '.repeat(8)}` })),
    context: { personal_space_id: 'space', personal_project_id: 'project', project_agent_id: 'lead', source_truncated: false },
    agent_receipt: { required: true, markdown: 'Synthetic owner' }, active_conflicts: [{ id: 'current-conflict' }],
    task_guidance: { rules: 'fuli://rules/task-entry#task_guidance', version: 'synthetic-rules' }, ...changes }, scope);
}

test('neither an intermediate nor a final paginated suffix is a whole-preference baseline', () => {
  for (const complete of [false, true]) {
    assert.equal(preferenceSnapshot(entry('page', { preferences_complete: complete,
      preference_delivery: { status: 'paginated', revision: 'same-revision', page_index: 5,
        page_count: 6, next_cursor: complete ? null : 'next' } })), null);
  }
});

test('a complete snapshot ignores task token churn and preference ordering, but binds every authority dimension', () => {
  const first = preferenceSnapshot(entry());
  const second = entry('task-b');
  second.effective_preferences.reverse();
  assert.equal(preferenceSnapshot(second).snapshotHash, first.snapshotHash);
  const changed = withPreferenceScope(second, { ...scope, preference_scope: { ...scope.preference_scope, workflow: 'review' } });
  assert.notEqual(preferenceSnapshot(changed).scopeHash, first.scopeHash);
  second.effective_preferences[0].confirmation_status = 'pending';
  assert.notEqual(preferenceSnapshot(second).snapshotHash, first.snapshotHash);
});

test('an acknowledged baseline produces complete updates and visible removals while retaining current task authority', () => {
  const original = entry();
  const baseline = { ...preferenceSnapshot(original), callId: 'native-call-a' };
  const next = entry('task-b');
  next.effective_preferences[0].instruction = 'Changed synthetic rule';
  next.effective_preferences.splice(1, 1);
  next.effective_preferences.push({ preference_key: 'new', preference_scope: 'global',
    confirmation_status: 'confirmed', instruction: 'New synthetic rule' });
  const delta = projectPreferenceDelta(next, baseline);
  assert.equal(delta.preference_delivery.status, 'delta');
  assert.equal(delta.preference_delivery.base_result, 'native-call-a');
  assert.equal(delta.effective_preferences, undefined);
  assert.equal(delta.preference_updates.length, 2);
  assert.equal(delta.preference_delivery.removed[0].preference_key, 'rule-1');
  assert.equal(delta.taskContextToken, 'task-b');
  assert.deepEqual(delta.context, next.context);
  assert.deepEqual(delta.active_conflicts, next.active_conflicts);
  assert.deepEqual(delta.agent_receipt, next.agent_receipt);
  const restored = new Map(original.effective_preferences.map(item => [item.preference_key, item]));
  for (const item of delta.preference_delivery.removed) restored.delete(item.preference_key);
  for (const item of delta.preference_updates) restored.set(item.preference_key, item);
  assert.deepEqual([...restored.values()].sort((a,b)=>a.preference_key.localeCompare(b.preference_key)),
    [...next.effective_preferences].sort((a,b)=>a.preference_key.localeCompare(b.preference_key)));
  assert.ok(JSON.stringify(delta).length < JSON.stringify(next).length);
});

test('unknown, changed-scope, blocked and non-saving baselines keep the full set', () => {
  const value = entry();
  assert.deepEqual(projectPreferenceDelta(value, null).effective_preferences,
    [...value.effective_preferences].sort((a,b)=>a.preference_key.localeCompare(b.preference_key)));
  const other = withPreferenceScope(entry(), { ...scope, project_agent_id: 'another-lead' });
  assert.equal(projectPreferenceDelta(value, { ...preferenceSnapshot(other), callId: 'old' }).preference_delivery, undefined);
  assert.equal(preferenceSnapshot(entry('blocked', { preferences_complete: false })), null);
  const tiny = entry('tiny', { effective_preferences: [] });
  assert.equal(projectPreferenceDelta(tiny, { ...preferenceSnapshot(tiny), callId: 'tiny-call' }).preference_delivery, undefined);
  assert.equal(preferenceSnapshot({ ...value }), null, 'serialized or forged input cannot supply private scope');
});

test('duplicate preference identities and unknown preference dimensions never become a delta authority', () => {
  const value = entry();
  value.effective_preferences.push({ ...value.effective_preferences[0], instruction: 'Conflicting duplicate' });
  assert.equal(preferenceSnapshot(value), null);
  assert.equal(preferenceSnapshot(withPreferenceScope(entry(), { ...scope, preference_scope: null })), null);
});

test('rec#5 C7-2: two clients holding the old version both get the edited one next, and an outdated one is removed', () => {
  const sessions = ['native-session-a', 'native-session-b'].map((session, index) => {
    const sessionScope = { ...scope, session_id: session };
    const cached = withPreferenceScope(entry(`task-${index}`), sessionScope);
    return { sessionScope, baseline: { ...preferenceSnapshot(cached), callId: `native-call-${index}` } };
  });
  for (const { sessionScope, baseline } of sessions) {
    // The Provider now answers the new version under the same preference key and
    // leaves the outdated one out (C8-1).
    const next = withPreferenceScope(entry('task-next'), sessionScope);
    next.effective_preferences[0] = { ...next.effective_preferences[0], instruction: 'Edited synthetic rule' };
    next.effective_preferences.splice(1, 1);
    const delta = projectPreferenceDelta(next, baseline);
    assert.equal(delta.preference_delivery.status, 'delta');
    assert.deepEqual(delta.preference_updates.map(item => [item.preference_key, item.instruction]),
      [['rule-0', 'Edited synthetic rule']]);
    assert.deepEqual(delta.preference_delivery.removed.map(item => item.preference_key), ['rule-1']);
    assert.ok(!JSON.stringify(delta).includes('Synthetic instruction 0:'), 'the old words are not sent again');
  }
});
