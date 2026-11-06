import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { createAgentWorkflows } from '../src/agent-workflows/port.js';

// rec#78 step 4 + 11-06 addition 5: a Skill drafted from kept experiences
// starts with its work map and asks at most three questions. Synthetic only.
const STEPS = [{ title: 'Bump the synthetic version' }, { title: 'Build the synthetic zip' }];
const WORK_MAP = { inputs: ['A merged change'], outputs: ['A release zip'], dependencies: ['The build script'],
  branches: ['A failed build stops the release'], acceptance: ['The zip starts on a clean machine'] };
const experience = (id, overrides = {}) => ({ id, name: id, type: 'ReusableExperience', confirmation_status: 'confirmed',
  attributes: { solution: 'x', searchTerms: ['Release'] }, confirmation_basis: { proposed_by: { kind: 'agent', label: 'fla-1' } }, ...overrides });

function application(t, nodes) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-skill-work-map-'));
  const agentWorkflows = createAgentWorkflows({ path: join(directory, 'agent-workflows.sqlite') });
  t.after(() => { agentWorkflows.close(); rmSync(directory, { recursive: true, force: true }); });
  const attention = [];
  return { attention, agentWorkflows, config: { personal: { spaceId: 'space' } },
    taskContextRegistry: { context: async () => ({ projectAgentId: 'fla-1', personalProjectId: 'app', sourceApplication: 'other' }) },
    personal: { graph: async () => ({ nodes, edges: [] }) },
    requestAgentAttention: async input => { attention.push(input); return { requestId: 'r' }; } };
}
const call = (app, name, input) => callAgentTool(app, name, { taskContextToken: 'fuli-task-skill', ...input });
const KEPT = ['k1', 'k2', 'k3'].map(id => experience(id));

test('the index names topics with three kept experiences, and only those', async (t) => {
  const app = application(t, [...KEPT, experience('p1', { confirmation_status: 'pending' }),
    experience('o1', { confirmation_basis: { proposed_by: { kind: 'agent', label: 'other' } } }),
    experience('k4', { attributes: { solution: 'x', searchTerms: ['lonely'] } })]);
  const index = await call(app, 'list_agent_workflows', {});
  assert.deepEqual(index.draftable, [{ topic: 'release', experienceIds: ['k1', 'k2', 'k3'] }]);
  assert.equal((await call(application(t, KEPT.slice(0, 2)), 'list_agent_workflows', {})).draftable, undefined);
});

test('a draft from kept experiences needs its work map and asks at most three questions once', async (t) => {
  const app = application(t, KEPT);
  const base = { name: 'Synthetic release', purpose: 'Ship a synthetic release', steps: STEPS, experienceIds: ['k1', 'k2', 'k3'] };
  await assert.rejects(call(app, 'propose_agent_workflow', base), /workMap/);
  await assert.rejects(call(app, 'propose_agent_workflow', { ...base, workMap: { ...WORK_MAP, acceptance: [] } }), /acceptance/);
  await assert.rejects(call(app, 'propose_agent_workflow', { ...base, experienceIds: ['k1', 'k2', 'not-kept'], workMap: WORK_MAP }),
    error => error.code === 'experiences_not_kept');
  const questions = ['Which channel gets the release?'];
  const drafted = await call(app, 'propose_agent_workflow', { ...base, workMap: { ...WORK_MAP, questions } });
  assert.deepEqual([drafted.status, drafted.questions], ['proposed', 'asked']);
  assert.equal(app.attention.length, 1);
  assert.deepEqual([app.attention[0].kind, app.attention[0].agentId], ['question', 'fla-1']);
  assert.match(app.attention[0].detail, /1\. Which channel gets the release\?/);
  // The person sees the work map with the steps; it is part of the version.
  const [shown] = app.agentWorkflows.overview({ personalSpaceId: 'space', agentId: 'fla-1' }).workflows;
  assert.deepEqual(shown.pending.workMap, { ...WORK_MAP, questions });
  assert.match(shown.pending.source, /^experiences:[0-9a-f]{24}$/);
  // The same draft again changes nothing and asks nothing.
  const again = await call(app, 'propose_agent_workflow', { ...base, workMap: { ...WORK_MAP, questions } });
  assert.equal(again.status, 'unchanged');
  assert.equal(app.attention.length, 1);
});

test('more than three questions is refused; an ordinary proposal needs no work map', async (t) => {
  const app = application(t, KEPT);
  await assert.rejects(call(app, 'propose_agent_workflow', { name: 'n', purpose: 'p', steps: STEPS, experienceIds: ['k1', 'k2', 'k3'],
    workMap: { ...WORK_MAP, questions: ['a', 'b', 'c', 'd'] } }));
  assert.equal((await call(app, 'propose_agent_workflow', { name: 'n', purpose: 'p', steps: STEPS })).status, 'proposed');
});
