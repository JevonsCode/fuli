import assert from 'node:assert/strict';
import test from 'node:test';
import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

const TOOLS = ['list_project_agents', 'get_project_agent_context', 'coordinate_project_agent_task'];
const CONFIG = { version: 1, personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-test-token', principalId: 'synthetic-principal', spaceId: 'synthetic-space' }, workspaces: [] };
const INPUT = { projectPath: '/synthetic/unregistered-child', agentId: 'synthetic-agent', queries: ['scope'],
  idempotencyKey: 'synthetic-explicit-project', title: 'Verify explicit scope', objective: 'Keep the selected project boundary.',
  workKind: 'verification', routingReason: 'Explicit registered project.', contextQueries: ['scope'] };
function toolInput(name) {
  const { projectPath, agentId, queries, ...coordination } = INPUT;
  if (name === 'list_project_agents') return { projectPath };
  if (name === 'get_project_agent_context') return { projectPath, agentId, queries };
  return { projectPath, ...coordination };
}
function fixture(resolution = { status: 'unmatched', personalProjectId: null }, denied = false) {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    projectPathResolver: () => resolution,
    fetchImpl: async (rawUrl, options = {}) => {
      const url = new URL(rawUrl), body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      if (url.pathname === '/v1/personal-projects') return Response.json([{ project_id: 'selected-project', profile: { name: 'Synthetic selected project' } }]);
      if (denied && ['/v1/project-agents', '/v1/project-agents/synthetic-agent', '/v1/project-agent-tasks'].includes(url.pathname)) return Response.json({ detail: 'Synthetic project access denied' }, { status: 403 });
      if (url.pathname === '/v1/project-agents') return Response.json([]);
      if (url.pathname === '/v1/project-agents/synthetic-agent') return Response.json({ agent_id: 'synthetic-agent', personal_space_id: 'synthetic-space', profile: { name: 'Synthetic Agent', responsibility: 'Check scope.', status: 'active', allowed_clients: ['other'] } });
      if (url.pathname === '/v1/project-agent-tasks' && options.method === 'POST') return Response.json({ task: { task_id: 'synthetic-task', personal_space_id: body.personal_space_id, personal_project_id: body.personal_project_id, status: 'completed', revision: 1, participants: [] }, decision: 'existing_task' });
      if (url.pathname === '/v1/collaboration-preferences') return Response.json({ conflicts: [], effective_preferences: [] });
      if (url.pathname === '/v1/search') return Response.json({ facts: [], entities: [] });
      return Response.json([]);
    }
  });
  return { app, calls };
}

test('all three project Agent tool schemas expose an optional bounded explicit project id', () => {
  for (const name of TOOLS) {
    const schema = listAgentTools().find(tool => tool.name === name).inputSchema;
    assert.equal(schema.properties.personalProjectId.maxLength, 128, name);
    assert.equal(schema.required.includes('personalProjectId'), false, name);
    assert.equal(schema.required.includes('projectPath'), true, 'preserve the existing path contract');
  }
});

for (const name of TOOLS) {
  test(`${name} forwards an explicit project through the existing resolver`, async () => {
    const { app, calls } = fixture();
    const result = await callAgentTool(app, name, { ...toolInput(name), personalProjectId: 'selected-project' });
    assert.notEqual(result.status, 'project_unresolved');
    const scoped = calls.filter(call => ['/v1/project-agents', '/v1/project-agents/synthetic-agent', '/v1/project-agent-tasks'].includes(call.path));
    assert.ok(scoped.length > 0);
    for (const call of scoped) {
      const payload = call.body ?? call.query;
      assert.equal(payload.personal_space_id, 'synthetic-space');
      assert.equal(payload.personal_project_id, 'selected-project');
    }
  });

  test(`${name} keeps unresolved-path behavior when the override is omitted`, async () => {
    const { app, calls } = fixture();
    const result = await callAgentTool(app, name, toolInput(name));
    assert.equal(result.status, 'project_unresolved');
    assert.deepEqual(calls.map(call => call.path), ['/v1/personal-projects']);
  });

  test(`${name} cannot override a conflicting exact path match`, async () => {
    const { app, calls } = fixture({ status: 'matched', personalProjectId: 'path-project' });
    await assert.rejects(callAgentTool(app, name, { ...toolInput(name), personalProjectId: 'selected-project' }), /conflicts with the exact projectPath match/);
    assert.deepEqual(calls.map(call => call.path), ['/v1/personal-projects']);
  });

  test(`${name} still obeys Provider authorization for an explicit project`, async () => {
    const { app, calls } = fixture(undefined, true);
    await assert.rejects(callAgentTool(app, name, { ...toolInput(name), personalProjectId: 'selected-project' }), /Synthetic project access denied/);
    assert.equal(calls.some(call => call.path === '/v1/search'), false);
  });
}

test('explicit coordination cannot cross the existing task-context project boundary', async () => {
  const { app, calls } = fixture();
  app.taskContextRegistry.context = async () => ({ personalProjectId: 'different-project' });
  await assert.rejects(callAgentTool(app, 'coordinate_project_agent_task', {
    ...toolInput('coordinate_project_agent_task'), personalProjectId: 'selected-project', taskContextToken: 'synthetic-task-context'
  }), /belongs to another project/);
  assert.equal(calls.some(call => call.path === '/v1/project-agent-tasks'), false);
});
