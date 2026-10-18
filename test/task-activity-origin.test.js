import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderTaskContextRegistry, taskRecord } from '../src/mcp/provider-task-context-registry.js';
import { beginTaskFromPreferences } from '../src/graphiti/agent-knowledge-workflows.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { createServer } from '../src/server.js';
import { closeServer } from '../test-support/server.js';
import { projectAgentTaskRecord, providerProjectAgentTaskSubmit } from '../src/graphiti/project-agent-mapping.js';

const origin = Object.freeze({ version: 1, kind: 'ai_internal', source: 'sealed_worker', purpose: 'test' });

test('task recovery and task list/detail keep the Provider activity origin; legacy stays unknown', () => {
  const context = { token: 'fuli-task-origin-fixture', session_id: 'fixture-session' };
  assert.deepEqual(taskRecord({ ...context, activity_origin: origin }).activityOrigin, origin);
  assert.equal(taskRecord(context).activityOrigin, null);
  assert.deepEqual(projectAgentTaskRecord({ activity_origin: origin }).activityOrigin, origin);
  assert.equal(projectAgentTaskRecord({}).activityOrigin, null);
});

test('task submission carries only its context handle, never a caller asserted activity origin', () => {
  const input = { taskContextToken: 'fuli-task-parent-fixture', activityOrigin: origin, activity_origin: origin };
  const request = providerProjectAgentTaskSubmit(input);
  assert.equal(request.task_context_token, input.taskContextToken);
  assert.equal('activity_origin' in request, false);
  assert.equal('task_context_token' in providerProjectAgentTaskSubmit({}), false);
});

test('only host roundtable metadata reaches the private Provider entry port', async () => {
  const grant = 'synthetic-host-grant-0123456789abcdef';
  let forwarded;
  const registry = new ProviderTaskContextRegistry({ beginTaskContext: async input => {
    forwarded = input;
    return { ...input, activity_origin: { ...origin, source: 'roundtable_delegation' } };
  } }, 'fixture-space');
  const app = { config: { personal: { spaceId: 'fixture-space' } }, taskContextRegistry: registry,
    roundtable: { taskEntryDelegation: () => ({ token: grant, sessionId: 'fixture-session' }) } };
  const preferences = { context: { personal_project_id: 'fixture-project', project_agent_id: null } };
  await beginTaskFromPreferences(app, preferences, { sessionId: 'fixture-session', workKind: 'test_validation',
    delegationToken: 'forged-payload-grant', activityOrigin: origin });
  assert.equal(forwarded.delegation_token, grant);
  assert.equal('activity_origin' in forwarded, false);
  delete app.roundtable;
  await beginTaskFromPreferences(app, preferences, { sessionId: 'fixture-session', workKind: 'test_validation',
    delegationToken: grant, activityOrigin: origin });
  assert.equal('delegation_token' in forwarded, false);
});

test('MCP and console list/detail deliver the same origin as the Provider mapping', async () => {
  const mapped = projectAgentTaskRecord({ task_id: 'fixture-task', activity_origin: origin });
  const app = { graphiti: true, close() {}, listProjectAgentTasks: async () => [mapped],
    viewProjectAgentTask: async () => mapped };
  const mcp = createMcpServer(app, { env: {}, toolNames: ['list_project_agent_tasks'], registerResources: false });
  const client = new Client({ name: 'origin-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const { server, url } = await createServer({ app, port: 0 });
  try {
    await mcp.connect(b); await client.connect(a);
    const called = await client.callTool({ name: 'list_project_agent_tasks',
      arguments: { personalSpaceId: 'fixture-space', personalProjectId: 'fixture-project' } });
    assert.deepEqual(called.structuredContent.result[0].activityOrigin, origin);
    const query = '?personalSpaceId=fixture-space&personalProjectId=fixture-project';
    const listed = await fetch(`${url}/api/project-agent-tasks${query}`);
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json())[0].activityOrigin, origin);
    const detail = await fetch(`${url}/api/project-agent-tasks/fixture-task${query}`);
    assert.equal(detail.status, 200);
    assert.deepEqual((await detail.json()).activityOrigin, origin);
  } finally {
    await client.close(); await mcp.close(); await closeServer(server);
  }
});
