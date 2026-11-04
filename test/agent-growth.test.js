import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgentGrowth } from '../src/graphiti/agent-growth.js';

const experience = (id, overrides = {}) => ({ id, name: `Synthetic approach ${id}`, type: 'ReusableExperience',
  summary: 'Run the focused suite first', attributes: { solution: 'Run the focused suite first' },
  confirmation_status: 'pending', confirmation_basis: { proposed_by: { kind: 'agent', label: 'lead-1' } },
  qualified_use_count: 0, distinct_task_count: 0, ...overrides });

function application(pages, { assignments = [{ personalProjectId: 'app', status: 'active' }] } = {}) {
  const reads = [];
  return { reads, config: { personal: { spaceId: 'space' } }, externalKnowledge: null,
    listProjectAgents: async () => [{ agentId: 'lead-1', assignments }],
    personal: { graph: async (spaceId, limit, projectId, offset) => {
      reads.push({ projectId, offset });
      return pages[projectId]?.[offset ?? 0] ?? { nodes: [], edges: [] };
    } } };
}

test('an FLA\'s experiences come proven-first, with what waits for the person ahead of what is kept', async () => {
  const app = application({ app: [{ nodes: [
    experience('kept', { confirmation_status: 'confirmed', qualified_use_count: 9, distinct_task_count: 5 }),
    experience('untried'),
    experience('used-once', { qualified_use_count: 1, distinct_task_count: 1 }),
    experience('promoted', { confirmation_status: 'agent_confirmed', qualified_use_count: 4, distinct_task_count: 3 }),
    experience('other-agent', { confirmation_basis: { proposed_by: { kind: 'agent', label: 'someone-else' } } }),
    experience('dropped', { invalid_at: '2026-11-01T00:00:00Z' }),
    { ...experience('a-fact'), type: 'Requirement' }], edges: [] }] });
  const growth = await getAgentGrowth(app, { personalSpaceId: 'space', agentId: 'lead-1' });
  assert.deepEqual(growth.items.map(item => item.itemId), ['promoted', 'used-once', 'untried', 'kept']);
  assert.deepEqual(growth.counts, { total: 4, proven: 2, kept: 1 });
  assert.equal(growth.items[0].solution, 'Run the focused suite first');
  assert.equal(growth.partial, false);
});

test('every active project is read page by page; a graph past the page cap is marked partial', async () => {
  const many = Object.fromEntries(Array.from({ length: 6 }, (_, page) => [page,
    { nodes: [experience(`p${page}`)], edges: [], truncated: true, next_offset: page + 1 }]));
  const app = application({ big: many, small: [{ nodes: [experience('s')], edges: [] }] }, { assignments: [
    { personalProjectId: 'big', status: 'active' }, { personalProjectId: 'small', status: 'active' },
    { personalProjectId: 'old', status: 'ended' }] });
  const growth = await getAgentGrowth(app, { personalSpaceId: 'space', agentId: 'lead-1' });
  assert.equal(growth.partial, true);
  assert.equal(growth.counts.total, 6);
  assert.deepEqual([...new Set(app.reads.map(read => read.projectId))], ['big', 'small']);
});

test('an Agent the space does not list has learned nothing; one project can be asked for', async () => {
  const app = application({ app: [{ nodes: [experience('x')], edges: [] }] });
  assert.equal((await getAgentGrowth(app, { personalSpaceId: 'space', agentId: 'unknown' })).counts.total, 0);
  const one = await getAgentGrowth(app, { personalSpaceId: 'space', agentId: 'lead-1', personalProjectId: 'app' });
  assert.equal(one.counts.total, 1);
});

test('the console route reads through the person\'s owner port and writes nothing', async () => {
  const { handleGraphApiRequest } = await import('../src/http/graph-api-router.js');
  const { getAgentGrowth: read } = await import('../src/graphiti/agent-growth.js');
  const owner = [];
  const app = { ...application({}), getAgentGrowth: (input, ownerReads) => read(app, input, ownerReads) };
  const ownerReads = { graph: async input => { owner.push(input); return { nodes: [experience('o', { distinct_task_count: 2 })], edges: [] }; } };
  let status; let body;
  const response = { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
  const handled = await handleGraphApiRequest({ request: { method: 'GET' }, response, ownerReads, app,
    url: new URL('http://127.0.0.1/api/project-agents/lead-1/growth?personalSpaceId=space') });
  assert.deepEqual([handled, status, body.counts.proven, body.items[0].proven], [true, 200, 1, true]);
  assert.deepEqual(owner.map(input => input.personalProjectId), ['app']);
  assert.equal(app.reads.length, 0, 'the console read never falls back to an Agent read');
});
