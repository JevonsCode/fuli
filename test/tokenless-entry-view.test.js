import assert from 'node:assert/strict';
import test from 'node:test';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { syntheticPreferences, syntheticTokenlessEntry } from '../test-support/synthetic-large-entry.js';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
// What the same entry showed before it was told apart: the view of a task that has a token.
const fullView = entry => {
  const { taskContextToken: _token, ...view } = compactTaskContext({ ...entry, taskContextToken: 'synthetic-token' });
  return view;
};

test('a token-less entry points to on-demand reads and keeps what the turn acts on', async t => {
  const entry = await syntheticTokenlessEntry({ items: syntheticPreferences(2) });
  const before = fullView(entry);
  const after = compactTaskContext(entry);
  t.diagnostic(`token-less entry: ${bytes(before)} -> ${bytes(after)} B`);
  assert.ok(bytes(after) <= bytes(before) * 0.65, `${bytes(before)} -> ${bytes(after)} B`);
  for (const key of ['effective_preferences', 'active_conflicts', 'deferred_conflicts', 'agent_receipt',
    'task_knowledge_recall', 'context', 'task_lifecycle', 'application_guidance']) {
    // A task entry names the application rules once and leaves the recall's pointer to them out (rec#88).
    const { guidance_ref: _ref, ...shown } = after[key] ?? {};
    const { guidance_ref: _refBefore, ...expected } = before[key] ?? {};
    assert.deepEqual(key === 'task_knowledge_recall' ? shown : after[key], key === 'task_knowledge_recall' ? expected : before[key], key);
  }
  assert.equal(after.task_lifecycle.reason, 'native_session_required');
  const continuity = after.project_agent_context;
  assert.deepEqual(continuity.role, before.project_agent_context.role);
  assert.deepEqual(continuity.memory, { revision: 7, view: 'omitted', read: { tool: 'get_project_agent_memory',
    arguments: { personalSpaceId: 'synthetic-space', personalProjectId: 'project', agentId: 'lead' } } });
  assert.deepEqual(continuity.global_memory.read.arguments.personalProjectId, null);
  assert.equal(continuity.global_memory.revision, 5);
  assert.deepEqual(continuity.team, { roster_total: 4, read: { tool: 'get_project_team',
    arguments: { personalSpaceId: 'synthetic-space', personalProjectId: 'project' } } });
  assert.equal(continuity.directorySnapshot, undefined);
  assert.equal(continuity.team_guidance, undefined);
  const [manager] = after.project_management_context.managers;
  assert.deepEqual(manager.read, { tool: 'list_employee_tools', arguments: { templateId: 'jefa', personalProjectId: 'project' } });
  assert.equal(manager.guidance.summary, before.project_management_context.managers[0].guidance.summary);
  assert.equal(manager.session, undefined);
  assert.equal(manager.board, undefined);
  assert.deepEqual(after.judgment_context, { agentId: 'employee.tonborg', guidance: before.judgment_context.guidance });
});

test('an entry with a task token keeps its previews', async () => {
  const entry = await syntheticTokenlessEntry({ items: [] });
  const view = compactTaskContext({ ...entry, taskContextToken: 'synthetic-token' });
  assert.equal(view.project_agent_context.memory.view, 'preview');
  assert.ok(view.project_agent_context.team.roster.length);
  // rec#88: an empty board's manager shows its reader instead of its tools and
  // session fields; Tonborg's saved policy is read by assess_agent_action itself.
  const [manager] = view.project_management_context.managers;
  if (entry.project_management_context.managers[0].board?.total === 0) {
    assert.equal(manager.tools, undefined);
    assert.deepEqual(manager.read, { tool: 'list_employee_tools', arguments: { templateId: 'jefa', personalProjectId: 'project' } });
  } else assert.ok(manager.tools);
  assert.deepEqual(Object.keys(view.judgment_context).sort(), ['agentId', 'guidance']);
});

test('an unavailable memory layer stays null in the token-less view', async () => {
  const entry = await syntheticTokenlessEntry({ items: [] });
  entry.project_agent_context = { ...entry.project_agent_context, global_memory: null };
  const view = compactTaskContext(entry).project_agent_context;
  assert.equal(view.global_memory, null);
  assert.equal(view.memory.view, 'omitted');
});
