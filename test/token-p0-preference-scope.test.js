import assert from 'node:assert/strict';
import test from 'node:test';
import { getCollaborationPreferences } from '../src/graphiti/collaboration-preference-workflow.js';

const rule = (id, qualifiers = {}) => ({ id, item_kind: 'entity', instruction: `Rule ${id}`,
  preference_key: id, preference_scope: 'global', preference_qualifiers: qualifiers });

test('task entry filters only definite structured session/workflow mismatches without capping global rules', async () => {
  const items = [rule('current-session', { sessionId: 'session-a' }),
    rule('other-session', { sessionId: 'session-b' }),
    rule('current-workflow', { workflow: 'implementation' }),
    rule('other-workflow', { workflow: 'release' }),
    rule('unknown', { workflow: { customCondition: 'leave intact' } }),
    ...Array.from({ length: 45 }, (_, i) => rule(`global-${i}`))];
  items.push({ ...rule('legacy-attributes'), preference_qualifiers: undefined,
    attributes: { workflow: 'implementation', unknownCondition: 'retain' } });
  const result = await getCollaborationPreferences({ config: { personal: { spaceId: 'space' } }, personal: {
    collaborationPreferences: async () => ({ effective_preferences: items, global_preferences: items }),
    listPreferenceConflicts: async () => []
  } }, { personalProjectId: 'project-a' }, {
    sessionId: 'session-a', workKind: 'implementation', workflow: 'implementation', agentInvocation: true
  }, async () => {});
  assert.deepEqual(result.effective_preferences.map(p => p.preference_key), items
    .filter(p => !['other-session', 'other-workflow'].includes(p.id)).map(p => p.id));
  assert.deepEqual(result.effective_preferences[0].preference_qualifiers, { sessionId: 'session-a' });
  assert.equal(result.context.task_scope_excluded_count, 2);
});

test('business workflow and work kind are independent dimensions', async () => {
  const items = [rule('business-workflow', { workflow: 'timesheet' }),
    rule('kind', { workKind: 'review' }), rule('empty', { sessionId: '' }),
    { ...rule('legacy-empty-canonical'), attributes: { sessionId: 'other-session', appliesWhen: 'keep unknown' } }];
  const application = { config: { personal: { spaceId: 'space' } }, personal: {
    collaborationPreferences: async () => ({ effective_preferences: items }), listPreferenceConflicts: async () => []
  } };
  const retained = await getCollaborationPreferences(application, { personalProjectId: 'project' },
    { sessionId: 'this-session', workKind: 'implementation', agentInvocation: true }, async () => {});
  assert.deepEqual(retained.effective_preferences.map(p => p.preference_key), ['business-workflow', 'empty']);
  const filtered = await getCollaborationPreferences(application, { personalProjectId: 'project' },
    { sessionId: 'this-session', workKind: 'implementation', workflow: 'leave-request', agentInvocation: true }, async () => {});
  assert.deepEqual(filtered.effective_preferences.map(p => p.preference_key), ['empty']);
});

test('missing task metadata and unknown scope formats conservatively retain scoped preferences', async () => {
  const items = [rule('session', { sessionId: 'saved-session' }), rule('workflow', { workflow: 'release' }),
    rule('unknown', { conditions: 'only for something unknown' })];
  const result = await getCollaborationPreferences({ config: { personal: { spaceId: 'space' } }, personal: {
    collaborationPreferences: async () => ({ effective_preferences: items }), listPreferenceConflicts: async () => []
  } }, { personalProjectId: null }, { agentInvocation: true }, async () => {});
  assert.equal(result.effective_preferences.length, 3);
});

test('legacy restrictive session text is normalized only from explicit single-session scope', async () => {
  const { preferenceAppliesToTask } = await import('../src/graphiti/preference-task-scope.js');
  const session = '12345678-1234-1234-1234-123456789abc';
  const scoped = { ...rule('legacy'), instruction: `仅在 Codex 会话 ${session} 中协作；不能扩大权限。` };
  assert.equal(preferenceAppliesToTask(scoped, { sessionId: 'other-session' }), false);
  assert.equal(preferenceAppliesToTask(scoped, { sessionId: session }), true);
  assert.equal(preferenceAppliesToTask(scoped, {}), true);
  for (const instruction of [`参考 Codex 会话 ${session} 的历史结果。`,
    `仅在 Codex 会话 ${session} 或其他会话中适用。`, '仅在公司工作中适用。']) {
    assert.equal(preferenceAppliesToTask({ ...scoped, instruction }, { sessionId: 'other-session' }), true);
  }
  assert.equal(preferenceAppliesToTask({ ...rule('provenance'), attributes: { sourceSessionId: session } }, { sessionId: 'other-session' }), true);
  assert.equal(preferenceAppliesToTask({ ...scoped, preference_qualifiers: { sessionId: 'canonical' } }, { sessionId: 'canonical' }), true);
});

test('an explicit unknown canonical session condition prevents legacy narrowing', async () => {
  const { preferenceAppliesToTask } = await import('../src/graphiti/preference-task-scope.js');
  const instruction = '仅在 Codex 会话 12345678-1234-1234-1234-123456789abc 中适用。';
  for (const condition of [null, '', [], { unknown: 'retain' }]) {
    assert.equal(preferenceAppliesToTask({ instruction, preference_qualifiers: { sessionId: condition } },
      { sessionId: 'other-session' }), true);
  }
});
