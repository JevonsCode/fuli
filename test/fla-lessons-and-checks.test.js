import assert from 'node:assert/strict';
import test from 'node:test';
import { recordFlaLesson } from '../src/fla-growth/lessons.js';
import { briefAcceptanceChecks, projectAcceptanceChecks } from '../src/acceptance-checks/port.js';
import { GRAPH_TOOL_DEFINITIONS } from '../src/agent-tools/graph-definitions.js';

// Synthetic tasks, lessons and checks only.
const task = { token: 'fuli-task-lesson', personalProjectId: 'app', projectAgentId: 'lead-1', sessionId: 's-1',
  sourceApplication: 'claude_code' };
const lesson = { taskContextToken: 'fuli-task-lesson', title: 'Run the focused suite before the full one',
  solution: 'Start with the module test, then the full suite once.', searchKeys: ['focused tests'] };

function lessonApp({ bound = task, enabled = true } = {}) {
  const captures = [];
  return { captures, config: { personal: { spaceId: 'space' } },
    getCapturePolicy: () => ({ enabled }),
    taskContextRegistry: { context: async () => bound },
    captureSessionKnowledge: async (input, options) => { captures.push({ input, options }); return { status: 'committed' }; } };
}

test('a one-off correction is applied and kept nowhere; a lasting one needs its boundary', async () => {
  const app = lessonApp();
  const once = await recordFlaLesson(app, { ...lesson, origin: 'correction', correctionScope: 'this_task' });
  assert.deepEqual([once.status, once.kept, app.captures.length], ['one_off', false, 0]);
  // No scope at all is not a lasting rule either.
  assert.equal((await recordFlaLesson(app, { ...lesson, origin: 'correction' })).status, 'one_off');
  await assert.rejects(recordFlaLesson(app, { ...lesson, origin: 'correction', correctionScope: 'lasting' }), /boundary/);
  assert.equal(app.captures.length, 0);
});

test('a lasting correction with a check waits pending in the FLA\'s project, keyed apart from the checkpoint', async () => {
  const app = lessonApp();
  const result = await recordFlaLesson(app, { ...lesson, origin: 'correction', correctionScope: 'lasting',
    boundary: 'Only this repository', check: { kind: 'regression_example', text: 'The focused test runs before the full suite' } });
  assert.equal(result.status, 'pending');
  const [{ input, options }] = app.captures;
  assert.equal(input.personalProjectId, 'app');
  assert.equal(input.sessionId, 's-1');
  assert.match(input.idempotencyKey, /^fuli-task-lesson:experiences:[0-9a-f]{16}:lesson$/);
  assert.equal(options.captureScope.personalProjectId, 'app');
  const [entity] = input.entities;
  assert.equal(entity.type, 'ReusableExperience');
  assert.equal(entity.confirmationStatus, 'pending');
  assert.deepEqual(entity.attributes.check, { kind: 'regression_example', text: 'The focused test runs before the full suite' });
  assert.equal(entity.attributes.origin, 'correction');
  assert.match(entity.confirmationBasis.existenceReason, /person corrected/);
  assert.equal(entity.confirmationBasis.proposedBy.label, 'lead-1');
});

test('capture off keeps nothing, and an unbound task has no FLA to learn', async () => {
  const off = lessonApp({ enabled: false });
  assert.equal((await recordFlaLesson(off, { ...lesson, origin: 'experience' })).status, 'capture_disabled');
  assert.equal(off.captures.length, 0);
  await assert.rejects(recordFlaLesson(lessonApp({ bound: { ...task, projectAgentId: null } }), { ...lesson, origin: 'experience' }),
    error => error.code === 'agent_not_bound');
  await assert.rejects(recordFlaLesson(lessonApp(), { ...lesson, origin: 'experience', check: { kind: 'vibe', text: 'x' } }), /check.kind/);
});

test('the lesson tool is listed with the graph tools (full profile; chat reaches it through fuli_call)', () => {
  assert.ok(GRAPH_TOOL_DEFINITIONS.some(tool => tool.name === 'record_fla_lesson'));
});

const node = (id, overrides = {}) => ({ id, name: id, type: 'ReusableExperience', attributes: { solution: 'x' },
  confirmation_status: 'confirmed', confirmation_basis: { proposed_by: { kind: 'agent', label: 'lead-1' }, confirmed_at: '2026-11-05T00:00:00Z' },
  ...overrides });
const checksApp = (nodes) => ({ config: { personal: { spaceId: 'space' } },
  listProjectAgents: async () => [{ agentId: 'lead-1', occupation: { role: 'engineering' } }, { agentId: 'qa-1', occupation: { role: 'qa' } }],
  personal: { graph: async () => ({ nodes, edges: [] }) } });

test('the acceptance list holds only kept, current lessons that carry a check, with the learner\'s occupation', async () => {
  const app = checksApp([
    node('kept-check', { attributes: { solution: 'x', check: { kind: 'acceptance_item', text: 'Build passes on Windows' } } }),
    node('newer', { attributes: { solution: 'x', check: { kind: 'regression_example', text: 'Empty list shows nothing' } },
      confirmation_basis: { proposed_by: { kind: 'agent', label: 'qa-1' }, confirmed_at: '2026-11-06T00:00:00Z' } }),
    node('pending-check', { confirmation_status: 'pending', attributes: { solution: 'x', check: { kind: 'acceptance_item', text: 'not kept' } } }),
    node('dropped', { invalid_at: '2026-11-06T00:00:00Z', attributes: { solution: 'x', check: { kind: 'acceptance_item', text: 'dropped' } } }),
    node('text-only')]);
  const { checks } = await projectAcceptanceChecks(app, { personalSpaceId: 'space', personalProjectId: 'app' });
  assert.deepEqual(checks.map(check => [check.checkId, check.kind, check.occupation, check.sourceAgentId]),
    [['newer', 'regression_example', 'qa', 'qa-1'], ['kept-check', 'acceptance_item', 'engineering', 'lead-1']]);
  const qa = await projectAcceptanceChecks(app, { personalSpaceId: 'space', personalProjectId: 'app', occupation: 'qa' });
  assert.deepEqual(qa.checks.map(check => check.checkId), ['newer']);
  assert.deepEqual((await projectAcceptanceChecks(checksApp([node('text-only')]), { personalSpaceId: 'space', personalProjectId: 'app' })).checks, []);
});
