import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskPreferencePager } from '../src/graphiti/task-preference-pages.js';
import { completePreferenceToolResult } from '../src/mcp/tool-result.js';

function projection() {
  const item = i => ({ preference_key: `synthetic-${i}`, preference_scope: 'project',
    instruction: `Synthetic ${i}: ${'𝒜规则\\\"\n'.repeat(300)} END_${i}`,
    attributes: { arbitraryMeaningfulQualifier: 'Preserved completely' }, confirmation_status: 'confirmed' });
  return { taskContextToken: 'synthetic-token', task_context_token: 'synthetic-token',
    preferences_complete: true, preference_delivery: { status: 'complete' }, truncated: false,
    checkpoint_required: true, same_task_recovery_available: true,
    context: { personal_space_id: 'synthetic', personal_project_id: 'sample', project_agent_id: 'reader',
      session_id: 'synthetic-owned-session', source_application: 'codex',
      preference_scope: { version: 1, work_kind: 'implementation', workflow: null } },
    effective_preferences: Array.from({ length: 20 }, (_, i) => item(i)),
    active_conflicts: Array.from({ length: 10 }, (_, i) => ({ alternatives: [item(i + 20), item(i + 30)],
      required_action: 'Resolve first, do not pick by weight' })),
    deferred_conflicts: Array.from({ length: 10 }, (_, i) => ({ left: item(i + 40), right: item(i + 50),
      required_action: 'Ask the user first' })),
    application_guidance: { authority: 'Keep human authority' }, task_guidance: { checkpoint: 'Required' },
    project_agent_context: { role: { name: 'Synthetic reader', responsibility: 'Preserve every field' } },
    agent_receipt: { required: true, markdown: 'Synthetic reader' } };
}

test('escaped Unicode preferences and whole conflict alternatives reconstruct exactly within every serialized envelope', () => {
  const original = projection();
  const pager = createTaskPreferencePager();
  const pages = [];
  let cursor;
  do {
    const page = pager.read(original, { cursor });
    const result = completePreferenceToolResult(page);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 32 * 1024);
    assert.deepEqual(JSON.parse(result.content[0].text), page);
    assert.equal(page.preferences_complete, page.preference_delivery.next_cursor === null);
    assert.equal(page.preference_delivery.page_index, pages.length);
    for (const field of ['context', 'agent_receipt']) {
      assert.deepEqual(page[field], original[field]);
    }
    pages.push(page);
    assert.ok(pages.length <= 60);
    cursor = page.preference_delivery.next_cursor;
  } while (cursor);
  assert.ok(pages.length > 1);
  for (const field of ['effective_preferences', 'active_conflicts', 'deferred_conflicts']) {
    assert.deepEqual(pages.flatMap(page => page[field]), original[field]);
    assert.equal(pages[0].preference_delivery.totals[field], original[field].length);
  }
  assert.equal(pages.at(-1).preference_delivery.page_count, pages.length);
  const merged = Object.assign({}, ...pages);
  for (const field of ['project_agent_context', 'application_guidance', 'task_guidance']) {
    assert.deepEqual(merged[field], original[field]);
  }
});

test('complete instruction metadata can occupy its own page instead of making an otherwise deliverable collection block', () => {
  const original = projection();
  original.project_agent_context.role.responsibility = 'Synthetic role constraint. '.repeat(400);
  original.application_guidance.authority = 'Synthetic authority constraint. '.repeat(400);
  const pager = createTaskPreferencePager();
  const pages = [];
  let cursor;
  do {
    const page = pager.read(original, { cursor });
    assert.equal(page.preference_delivery.status, 'paginated');
    assert.ok(Buffer.byteLength(JSON.stringify(completePreferenceToolResult(page))) <= 32 * 1024);
    pages.push(page);
    assert.ok(pages.length <= 65);
    cursor = page.preference_delivery.next_cursor;
  } while (cursor);
  const merged = Object.assign({}, ...pages);
  assert.deepEqual(merged.project_agent_context, original.project_agent_context);
  assert.deepEqual(merged.application_guidance, original.application_guidance);
  assert.equal(pages.filter(page => page.project_agent_context).length, 1);
});

test('cursor expiry, process restart and bounded cache eviction require restarting the same reader', () => {
  let clock = 0;
  const pager = createTaskPreferencePager({ now: () => clock });
  const original = projection();
  const first = pager.read(original);
  const cursor = first.preference_delivery.next_cursor;
  clock = 15 * 60 * 1000 - 1;
  assert.deepEqual(pager.read(original), first);
  assert.equal(pager.read(original, { cursor }).preference_delivery.page_index, 1);
  clock++;
  assert.throws(() => pager.read(original, { cursor }), /invalid, expired or its snapshot changed/);
  const renewed = pager.read(original);
  assert.equal(renewed.preference_delivery.revision, first.preference_delivery.revision);
  assert.notEqual(renewed.preference_delivery.next_cursor, cursor);
  assert.throws(() => createTaskPreferencePager().read(original, { cursor: renewed.preference_delivery.next_cursor }), /invalid/);
  for (let i = 0; i < 128; i++) pager.read({ ...original, taskContextToken: `other-${i}` });
  assert.throws(() => pager.read(original, { cursor: renewed.preference_delivery.next_cursor }), /invalid/);
});

test('every content, scope and identity change invalidates an otherwise live cursor', () => {
  for (const change of [
    value => { value.effective_preferences[0].instruction += ' Changed'; },
    value => { value.active_conflicts[0].alternatives.reverse(); },
    value => { value.deferred_conflicts[0].required_action += ' Changed'; },
    value => { value.effective_preferences.pop(); },
    value => { value.taskContextToken = 'another-token'; },
    value => { value.context.session_id = 'other-session'; },
    value => { value.context.personal_space_id = 'other-space'; },
    value => { value.context.personal_project_id = 'other-project'; },
    value => { value.context.project_agent_id = 'other-agent'; },
    value => { value.context.source_application = 'claude_code'; },
    value => { value.context.preference_scope.workflow = 'release'; },
    value => { value.application_guidance.authority += ' Changed'; }
  ]) {
    const pager = createTaskPreferencePager();
    const original = projection();
    const cursor = pager.read(original).preference_delivery.next_cursor;
    change(original);
    assert.throws(() => pager.read(original, { cursor }), /snapshot changed/);
  }
});
