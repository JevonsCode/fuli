import assert from 'node:assert/strict';
import test from 'node:test';
import { experienceCapture } from '../src/graphiti/task-experiences.js';
import { normalizeTaskCaptures } from '../src/graphiti/task-knowledge-routing.js';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { GRAPH_TOOL_DEFINITIONS } from '../src/agent-tools/graph-definitions.js';

const task = { token: 'fuli-task-experience', personalProjectId: 'fuli', projectAgentId: 'lead-fuli' };
const experience = { task: 'Make a Windows tray build reuse assets after a version bump',
  searchKeys: ['tray build', 'version bump', 'lockfile'], solution: 'Compare the lockfile without the root version.',
  boundary: 'Only when dependencies are unchanged' };

test('experiences become one pending current-project capture searchable by their keys', () => {
  const { capture, captureRouting } = experienceCapture(task, [experience], { sourceApplication: 'claude_code',
    now: new Date('2026-10-18T00:00:00Z') });
  const [entity] = capture.entities;
  assert.equal(entity.type, 'ReusableExperience');
  assert.equal(entity.name, experience.task);
  assert.deepEqual(entity.attributes.searchTerms, experience.searchKeys);
  assert.match(entity.summary, /适用边界：Only when dependencies are unchanged/);
  assert.equal(entity.confirmationBasis.proposedBy.label, 'lead-fuli');
  assert.deepEqual(captureRouting, [{ scope: 'current_project', entityKeys: [entity.key], relationshipKeys: [] }]);
  assert.match(entity.key, /^experience-[0-9a-f]{24}$/);
  // The generated capture passes the same routing and pending rules as a hand-written one.
  const [batch] = normalizeTaskCaptures(task, capture, captureRouting);
  assert.equal(batch.scope, 'current_project');
  assert.equal(batch.capture.entities[0].confirmationStatus, 'pending');
  const again = experienceCapture(task, [experience], { now: new Date('2026-10-19T00:00:00Z') });
  assert.equal(again.capture.idempotencyKey, capture.idempotencyKey, 'the same experiences retry idempotently');
});

test('experiences are bounded and need a registered current project', () => {
  for (const bad of [[], [experience, experience, experience, experience], [{ ...experience, searchKeys: [] }],
    [{ ...experience, solution: ' ' }]]) {
    assert.throws(() => experienceCapture(task, bad), /experiences/);
  }
  const unclaimed = experienceCapture({ ...task, personalProjectId: null }, [experience]);
  assert.throws(() => normalizeTaskCaptures({ ...task, personalProjectId: null }, unclaimed.capture, unclaimed.captureRouting),
    /registered current project/);
});

test('a checkpoint takes experiences instead of, never alongside, a capture', async () => {
  const app = { taskContextRegistry: { context: async () => task } };
  await assert.rejects(checkpointTaskKnowledge(app, { taskContextToken: 't', disposition: 'capture_candidates', reason: 'r',
    experiences: [experience], capture: { entities: [] } }), /not both/);
  await assert.rejects(checkpointTaskKnowledge(app, { taskContextToken: 't', disposition: 'retain_nothing', reason: 'r',
    experiences: [experience] }), /capture_candidates/);
  const tool = GRAPH_TOOL_DEFINITIONS.find(item => item.name === 'checkpoint_task_knowledge');
  assert.deepEqual(tool.inputSchema.properties.experiences.items.required, ['task', 'searchKeys', 'solution']);
});
