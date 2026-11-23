import assert from 'node:assert/strict';
import test from 'node:test';
import { heldPreferences, heldStatus, preferenceSnapshot, projectPreferenceDelta, withPreferenceScope }
  from '../src/conversations/preference-snapshot.js';

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
    task_guidance: { rules: 'fuli://rules/task-entry/task_guidance', version: 'synthetic-rules' }, ...changes }, scope);
}
// A verified earlier frame as preference-session.js passes it: named by the
// revision it showed the model.
const acknowledged = snapshot => ({ ...snapshot, revision: snapshot.snapshotHash.slice(0, 12) });

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
  const baseline = acknowledged(preferenceSnapshot(original));
  const next = entry('task-b');
  next.effective_preferences[0].instruction = 'Changed synthetic rule';
  next.effective_preferences.splice(1, 1);
  next.effective_preferences.push({ preference_key: 'new', preference_scope: 'global',
    confirmation_status: 'confirmed', instruction: 'New synthetic rule' });
  const delta = projectPreferenceDelta(next, baseline, new Map());
  assert.equal(delta.preference_delivery.status, 'delta');
  assert.equal(delta.preference_delivery.base_revision, baseline.revision);
  assert.match(delta.preference_delivery.revision, /^[0-9a-f]{12}$/);
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
  assert.equal(projectPreferenceDelta(value, acknowledged(preferenceSnapshot(other)), new Map()).preference_delivery, undefined);
  assert.equal(preferenceSnapshot(entry('blocked', { preferences_complete: false })), null);
  const tiny = entry('tiny', { effective_preferences: [] });
  assert.equal(projectPreferenceDelta(tiny, acknowledged(preferenceSnapshot(tiny)), new Map()).preference_delivery, undefined);
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
    return { sessionScope, baseline: acknowledged(preferenceSnapshot(cached)) };
  });
  for (const { sessionScope, baseline } of sessions) {
    // The Provider now answers the new version under the same preference key and
    // leaves the outdated one out (C8-1).
    const next = withPreferenceScope(entry('task-next'), sessionScope);
    next.effective_preferences[0] = { ...next.effective_preferences[0], instruction: 'Edited synthetic rule' };
    next.effective_preferences.splice(1, 1);
    const delta = projectPreferenceDelta(next, baseline, new Map());
    assert.equal(delta.preference_delivery.status, 'delta');
    assert.deepEqual(delta.preference_updates.map(item => [item.preference_key, item.instruction]),
      [['rule-0', 'Edited synthetic rule']]);
    assert.deepEqual(delta.preference_delivery.removed.map(item => item.preference_key), ['rule-1']);
    assert.ok(!JSON.stringify(delta).includes('Synthetic instruction 0:'), 'the old words are not sent again');
  }
});

test('rec#15 D-29.9: a revision another set already shows in the generation is extended, never reused', () => {
  const value = entry();
  const { snapshotHash } = preferenceSnapshot(value);
  assert.equal(projectPreferenceDelta(value, null, new Map()).revision, snapshotHash.slice(0, 12));
  const taken = new Map([[snapshotHash.slice(0, 12), { snapshotHash: 'another-set' }]]);
  assert.equal(projectPreferenceDelta(value, null, taken).revision, snapshotHash.slice(0, 16));
  // The same set shown again keeps its revision; a frame that can never be
  // confirmed (no readable generation) and an empty set carry none.
  assert.equal(projectPreferenceDelta(value, null, new Map([[snapshotHash.slice(0, 12), { snapshotHash }]])).revision,
    snapshotHash.slice(0, 12));
  assert.equal(projectPreferenceDelta(value, null, null).revision, undefined);
  assert.equal(projectPreferenceDelta(entry('empty', { effective_preferences: [] }), null, new Map()).revision, undefined);
  const every = new Map(Array.from({ length: 14 }, (_, i) => [snapshotHash.slice(0, 12 + 4 * i), { snapshotHash: null }]));
  assert.equal(projectPreferenceDelta(value, null, every).revision, undefined, 'still colliding: complete, and never a base');
});

// Design T3: what a later bounded frame keeps of its base. A preference is
// held where the base spelled it out, changed where its body differs since,
// indexed where the base's index named it at its own layer, and new otherwise:
// a project-layer rule is not the global one its base indexed under that key.
test('a held base tells each preference listed, changed, indexed or new, by key and layer', () => {
  const base = acknowledged(preferenceSnapshot(entry()));
  const held = heldPreferences({ ...base, omittedIndex: ['rule-40 — Synthetic global rule', 'rule-41 (project) — Synthetic'] });
  const [listed, changed] = entry().effective_preferences;
  const item = (key, layer) => ({ ...listed, preference_key: key, preference_scope: layer,
    ...(layer === 'project' ? {} : { preference_project_id: undefined }) });
  assert.equal(heldStatus(listed, held), 'listed');
  assert.equal(heldStatus({ ...changed, instruction: 'Changed rule' }, held), 'changed');
  assert.equal(heldStatus(item('rule-40', 'global'), held), 'indexed');
  assert.equal(heldStatus(item('rule-40', 'project'), held), 'new');
  assert.equal(heldStatus(item('rule-41', 'project'), held), 'indexed');
  assert.equal(heldStatus(item('rule-42', 'project'), held), 'new');
});

// A complete frame in place of a delta replaces the earlier set, so it names
// what its base had that the whole entry no longer has; not what an inline
// budget only leaves out of it.
test('a complete frame names the preferences its base had that are gone, not ones it only leaves out', () => {
  const base = acknowledged(preferenceSnapshot(entry()));
  const whole = entry('task-b');
  whole.effective_preferences.splice(3, 1);
  const bounded = entry('task-b', { effective_preferences: whole.effective_preferences.slice(0, 10),
    preferences_omitted: { count: 9 } });
  const frame = projectPreferenceDelta(bounded, base, new Map(), null, preferenceSnapshot(whole));
  assert.equal(frame.preference_delivery, undefined);
  assert.deepEqual(frame.preferences_removed, ['rule-3 (project)']);
  // An unbounded change is a delta, which names removals itself.
  const delta = projectPreferenceDelta(whole, base, new Map());
  assert.equal(delta.preferences_removed, undefined);
  assert.equal(delta.preference_delivery.removed.length, 1);
});
