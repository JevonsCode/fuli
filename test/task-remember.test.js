import assert from 'node:assert/strict';
import test from 'node:test';
import { compactTaskCapture, rememberCapture } from '../src/graphiti/task-remember.js';
import { normalizeTaskCaptures } from '../src/graphiti/task-knowledge-routing.js';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { GRAPH_TOOL_DEFINITIONS } from '../src/agent-tools/graph-definitions.js';

const task = { token: 'fuli-task-remember', personalProjectId: 'alpha-ledger', projectAgentId: 'lead-alpha' };
const preference = { kind: 'preference', text: 'Answer with the conclusion first, then the reasons.',
  quote: '我个人习惯回答先给结论再给理由，所有项目都适用', aspect: 'judgment_preference' };
const fact = { kind: 'project_fact', text: 'The ledger CSV is semicolon-delimited; the first column is an ISO date.' };

test('remember routes a global preference and a project fact through the normal pending rules', () => {
  const { capture, captureRouting } = rememberCapture(task, [preference, fact], { sourceApplication: 'claude_code',
    now: new Date('2026-10-19T00:00:00Z') });
  const [globalKey, factKey] = capture.entities.map(entity => entity.key);
  assert.match(globalKey, /^remember-[0-9a-f]{24}$/);
  assert.deepEqual(captureRouting.map(batch => [batch.scope, batch.entityKeys]),
    [['personal_global', [globalKey]], ['current_project', [factKey]]]);
  assert.equal(captureRouting[0].sourceExcerpt, preference.quote, 'the user\'s words are the global evidence');
  const batches = normalizeTaskCaptures(task, capture, captureRouting);
  const global = batches.find(batch => batch.scope === 'personal_global');
  const project = batches.find(batch => batch.scope === 'current_project');
  assert.equal(global.capture.entities[0].type, 'PersonalPreference');
  assert.equal(global.capture.entities[0].profileAspect, 'judgment_preference');
  assert.equal(project.capture.entities[0].type, 'ProjectFact');
  for (const batch of [global, project]) assert.equal(batch.capture.entities[0].confirmationStatus, 'pending');
  const again = rememberCapture(task, [preference, fact], { now: new Date('2026-10-20T00:00:00Z') });
  assert.equal(again.capture.idempotencyKey, capture.idempotencyKey, 'the same items retry idempotently');
});

test('a global preference needs the user\'s words; a project preference stays in the project', () => {
  assert.throws(() => rememberCapture(task, [{ kind: 'preference', text: 'Short answers.' }]), /quote/);
  const { capture, captureRouting } = rememberCapture(task, [{ kind: 'preference', text: 'Use semicolons in this repo.', scope: 'project' }]);
  assert.deepEqual(captureRouting, [{ scope: 'current_project', entityKeys: [capture.entities[0].key], relationshipKeys: [] }]);
  for (const bad of [[], Array(9).fill(fact), [{ kind: 'chat', text: 'nice weather' }], [{ ...fact, text: ' ' }],
    [{ ...preference, aspect: 'mood' }], [{ ...preference, scope: 'team' }]]) {
    assert.throws(() => rememberCapture(task, bad), /remember/);
  }
});

test('experiences and remember share one capture and one current-project batch', () => {
  const experience = { task: 'Parse the ledger', searchKeys: ['csv'], solution: 'Split on semicolons.' };
  const { capture, captureRouting } = compactTaskCapture(task, { experiences: [experience], remember: [preference, fact] });
  const [experienceKey, globalKey, factKey] = capture.entities.map(entity => entity.key);
  assert.match(experienceKey, /^experience-[0-9a-f]{24}$/);
  assert.deepEqual(captureRouting.map(batch => [batch.scope, batch.entityKeys]),
    [['current_project', [experienceKey, factKey]], ['personal_global', [globalKey]]]);
  assert.equal(normalizeTaskCaptures(task, capture, captureRouting).length, 2);
});

test('a checkpoint takes remember instead of a capture and lists it in the tool schema', async () => {
  const app = { taskContextRegistry: { context: async () => task } };
  await assert.rejects(checkpointTaskKnowledge(app, { taskContextToken: 't', disposition: 'capture_candidates', reason: 'r',
    remember: [fact], capture: { entities: [] } }), /remember, or a capture/);
  await assert.rejects(checkpointTaskKnowledge(app, { taskContextToken: 't', disposition: 'retain_nothing', reason: 'r',
    remember: [fact] }), /capture_candidates/);
  const tool = GRAPH_TOOL_DEFINITIONS.find(item => item.name === 'checkpoint_task_knowledge');
  assert.deepEqual(tool.inputSchema.properties.remember.items.required, ['kind', 'text']);
});

test('remembered items are keyed by content, so later tasks never collide with earlier knowledge', () => {
  const first = rememberCapture(task, [fact]).capture.entities[0].key;
  const other = rememberCapture({ ...task, token: 'fuli-task-later' },
    [{ kind: 'project_fact', text: 'Cobalt rollout: region west-7, shard cedar-23.' }]).capture.entities[0].key;
  const same = rememberCapture({ ...task, token: 'fuli-task-again' }, [fact]).capture.entities[0].key;
  assert.notEqual(first, other, 'a different fact in a later task gets its own key');
  assert.equal(first, same, 'remembering the same fact again keeps one item');
  assert.equal(rememberCapture(task, [fact, fact]).capture.entities.length, 1);
});
