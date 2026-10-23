import assert from 'node:assert/strict';
import test from 'node:test';
import { agentMemoryRecord, scopedAgentMemoryView } from '../src/graphiti/project-agent-memory.js';
import { loadProjectAgentContinuity } from '../src/graphiti/project-agent-task-entry.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { renderAgentMemoryExport } from '../src/agents/directory-snapshots.js';

const scope = { personalSpaceId: 'synthetic-space', personalProjectId: null, agentId: 'synthetic-agent' };
const agent = { agentId: scope.agentId, memoryScope: 'reviewed_agent', profile: {
  name: 'Synthetic Agent', status: 'active', responsibility: 'Synthetic fixture'
} };
function record(revision, scrubbed = false) {
  return { checkpoint_id: `checkpoint-${revision}`, personal_space_id: scope.personalSpaceId,
    personal_project_id: scope.personalProjectId, agent_id: scope.agentId, revision,
    created_at: '2026-10-24T00:00:00Z',
    ...(scrubbed ? { memory: null, memory_state: 'scrubbed', scrubbed_by: 'synthetic-deletion' }
      : { memory: { summary: `Unchanged older revision ${revision}.`, decisions: [], open_threads: [], next_actions: [] },
        source_application: 'codex', source_session_id: 'synthetic-session', task_id: 'synthetic-task' }) };
}
function view() {
  return { personal_space_id: scope.personalSpaceId, personal_project_id: null, agent_id: scope.agentId,
    scope: 'private_agent_global', revision: 3, current: record(3, true), history: [record(1), record(2, true)] };
}

test('scrubbed current and history keep revision metadata without falling back to old words', () => {
  const result = scopedAgentMemoryView(view(), scope);
  assert.equal(result.revision, 3);
  assert.equal(result.current.revision, 3);
  assert.equal(result.current.memory, null);
  assert.equal(result.current.memoryState, 'scrubbed');
  assert.equal(result.current.scrubbedBy, 'synthetic-deletion');
  assert.equal(result.history[0].memory.summary, 'Unchanged older revision 1.');
  assert.equal(result.history[1].memoryState, 'scrubbed');
  assert.match(result.scrubbedGuidance, /修订 3/);
  assert.match(result.scrubbedGuidance, /expectedRevision 3/);
  for (const field of ['sourceApplication', 'sourceSessionId', 'taskId']) assert.equal(Object.hasOwn(result.current, field), false);
});

test('task entry and its compact view retain a scrubbed current with bilingual rewrite guidance', async () => {
  const app = { config: { personal: { spaceId: scope.personalSpaceId } }, personal: {
    getProjectAgentMemory: async () => view()
  } };
  const context = await loadProjectAgentContinuity(app, { projectId: null, agent,
    sourceApplication: 'codex', taskPrompt: null, selectionReason: 'explicit_agent', matchBasis: [],
    includeTeam: false, includeKnowledge: false });
  assert.equal(context.status, 'ready');
  const compact = compactTaskContext({ project_agent_context: context }).project_agent_context;
  for (const value of [context.memory, compact.memory]) {
    assert.equal(value.current.memory, null);
    assert.equal(value.current.memoryState, 'scrubbed');
    assert.equal(value.revision, 3);
    assert.match(value.scrubbedGuidance, /当前工作记忆正文已随来源删除清除（修订 3）/);
    assert.match(value.scrubbedGuidance, /does not fall back to an older version/);
    assert.match(value.scrubbedGuidance, /expectedRevision 3/);
  }
});

test('export renders cleared revision guidance instead of claiming there were never notes', () => {
  const mapped = scopedAgentMemoryView(view(), scope);
  const output = renderAgentMemoryExport({ agent, revision: mapped.revision, current: mapped.current,
    generatedAt: '2026-10-24T00:00:01Z' });
  assert.match(output.markdown, /当前工作记忆正文已随来源删除清除（修订 3）/);
  assert.match(output.markdown, /expectedRevision 3/);
  assert.doesNotMatch(output.markdown, /Unchanged older|No working memory has been recorded/);
});

for (const invalid of [
  { ...record(3, true), memory: { summary: 'Forbidden residual body' } },
  { ...record(3), memory: null },
  { ...record(3), memory_state: 'unknown' },
  { ...record(3, true), scrubbed_by: null }
]) test(`invalid memory-state contract is refused: ${JSON.stringify(invalid.memory_state ?? 'present')}/${invalid.memory === null}`, () => {
  assert.throws(() => agentMemoryRecord(invalid), { code: 'validation' });
});

test('normal record and entry bytes do not grow when Provider emits its default present state', () => {
  const legacy = record(2);
  assert.equal(JSON.stringify(agentMemoryRecord({ ...legacy, memory_state: 'present', scrubbed_by: null })),
    JSON.stringify(agentMemoryRecord(legacy)));
});
