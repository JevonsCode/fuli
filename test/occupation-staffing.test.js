import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectAgentControlPlaneApplication } from '../src/graphiti/project-agent-control-plane.js';

function fixture({ count = 6, role = 'engineering', dedicated = false, unavailable = false } = {}) {
  const calls = [];
  const app = Object.assign(new ProjectAgentControlPlaneApplication(), {
    config: { personal: { spaceId: 'space' } },
    taskContextRegistry: { context: async () => ({ projectAgentId: 'lead', personalProjectId: 'sample' }) },
    personal: {
      listProjectAgents: async () => [{ agent_id: 'specialist', occupation: { role },
        profile: { name: 'Specialist', allowed_clients: [unavailable ? 'claude_code' : 'codex'], work_kinds: ['implementation'] },
        assignments: [{ status: 'active', personal_project_id: 'source', work_kinds: ['implementation'] }] }],
      getProjectAgentCoordinationPolicy: async (_s, p) => ({ team_lead_agent_id: p === 'sample' ? 'lead' : 'source-lead' }),
      agentLoan: async () => ({ loans: [] }),
      occupationDemand: async input => { calls.push(input); return { window_days: 30, task_threshold: 5,
        occupations: [{ occupation: 'engineering', task_count: count, has_dedicated: dedicated }] }; }
    },
    listExecutors: async () => [], listExecutorRoutingRules: async () => [],
    getProjectAgent: async () => ({ profile: {} })
  });
  return { app, calls };
}
const input = { taskContextToken: 'task', sourceApplication: 'codex', taskSize: 'small', workKind: 'implementation', occupation: 'engineering' };

test('same-occupation cross-project reuse stays loan-gated while recurring demand only proposes a dedicated hire', async () => {
  const { app, calls } = fixture();
  const result = await app.planAgentCollaboration(input);
  assert.equal(result.divisionPlan.workstreams[0].action, 'request_loan');
  assert.equal(result.recruitment, null);
  assert.equal(result.executionStarted, false);
  assert.equal(result.staffingDemand.proposals[0].occupation, 'engineering');
  assert.equal(result.staffingDemand.proposals[0].action, 'propose_dedicated');
  assert.equal(result.staffingDemand.proposals[0].requiresConfirmation, true);
  assert.deepEqual(calls, [{ personal_space_id: 'space', personal_project_id: 'sample', occupations: ['engineering'] }]);
});

test('five tasks, an existing dedicated specialist and unavailable clients never trigger automatic recruitment', async () => {
  for (const options of [{ count: 5 }, { dedicated: true }]) {
    const { app } = fixture(options);
    assert.deepEqual((await app.planAgentCollaboration(input)).staffingDemand.proposals, []);
  }
  const { app } = fixture({ unavailable: true });
  const result = await app.planAgentCollaboration(input);
  assert.equal(result.recruitment, null);
  assert.equal(result.divisionPlan.workstreams[0].action, 'blocked');
  assert.equal(result.executionStarted, false);
});

test('no explicit occupation leaves ordinary planning unchanged and does not query demand', async () => {
  const { app, calls } = fixture();
  const { occupation, ...legacy } = input;
  assert.equal((await app.planAgentCollaboration(legacy)).staffingDemand, undefined);
  assert.equal(calls.length, 0);
});

test('demand query failure stays unknown and preserves the reusable specialist', async () => {
  const { app } = fixture();
  app.personal.occupationDemand = async () => { throw new Error('offline'); };
  const result = await app.planAgentCollaboration(input);
  assert.equal(result.staffingDemand.status, 'unavailable');
  assert.equal(result.recruitment, null);
  assert.equal(result.divisionPlan.workstreams[0].action, 'request_loan');
});

test('custom thresholds are honored without changing the existing plan', async () => {
  const { app } = fixture();
  app.personal.occupationDemand = async () => ({ window_days: 7, task_threshold: 2,
    occupations: [{ occupation: 'engineering', task_count: 3, has_dedicated: false }] });
  const result = await app.planAgentCollaboration(input);
  assert.equal(result.staffingDemand.window_days, 7);
  assert.equal(result.staffingDemand.proposals.length, 1);
});

test('the Provider client sends only the exact scope and requested occupations', async () => {
  const { GraphitiProviderClient } = await import('../src/graphiti/provider-client.js');
  let sent;
  const client = new GraphitiProviderClient({ baseUrl: 'http://provider.test', accessToken: 'synthetic',
    fetchImpl: async (url, options) => { sent = { url, ...options }; return new Response(JSON.stringify({ occupations: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  const request = { personal_space_id: 'space', personal_project_id: 'sample', occupations: ['engineering'] };
  assert.deepEqual(await client.occupationDemand(request), { occupations: [] });
  assert.equal(sent.url, 'http://provider.test/v1/occupation-demand/query');
  assert.equal(sent.method, 'POST');
  assert.deepEqual(JSON.parse(sent.body), request);
});

test('demand follows actual streams, including default testing but excluding unused independent work', async () => {
  const { app, calls } = fixture();
  await app.planAgentCollaboration({ ...input, taskSize: 'standard', independentWork: { occupation: 'design' } });
  assert.deepEqual(calls[0].occupations, ['engineering', 'testing']);
  calls.length = 0;
  await app.planAgentCollaboration({ ...input, taskSize: 'standard', workKind: 'test_validation', occupation: 'testing',
    independentWork: { occupation: 'design' }, verificationOccupation: 'research' });
  assert.deepEqual(calls[0].occupations, ['testing']);
});
