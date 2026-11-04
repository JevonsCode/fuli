import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { checkpointRememberSchema } from '../src/agent-tools/checkpoint-definitions.js';
import { coordinateProjectAgentTask } from '../src/graphiti/project-agent-workflows.js';
import { WORK_KINDS } from '../src/graphiti/task-scene.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

// rec#86 and the rec#83 follow-up: what task entry tells a caller to send is
// accepted, and a refused coordination says why. Synthetic only.
test('a tool with no use for the task token ignores it instead of refusing the call', async (t) => {
  const server = createMcpServer({}, { sourceApplication: 'codex', toolNames: ['list_agent_interfaces'] });
  const client = new Client({ name: 'synthetic', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  t.after(() => client.close());
  const result = await client.callTool({ name: 'list_agent_interfaces', arguments: { taskContextToken: 'fuli-task-synthetic' } });
  assert.equal(result.isError, undefined, JSON.stringify(result).slice(0, 300));
  const other = await client.callTool({ name: 'list_agent_interfaces', arguments: { unknownField: true } });
  assert.equal(other.isError, true, 'any other unknown field is still refused');
});

test('remember advertises the work kinds it accepts', () => {
  assert.deepEqual(checkpointRememberSchema.items.properties.workKind.enum, [...WORK_KINDS]);
});

test('coordinating from a task of another project is refused with what to do, not an internal error', async () => {
  const app = { config: { personal: { spaceId: 'space-a' } }, personal: { getPersonalProject: async () => ({ scope_type: 'project' }) },
    taskContextRegistry: { context: async () => ({ token: 't', personalProjectId: 'project-a' }) } };
  await assert.rejects(coordinateProjectAgentTask(app, { status: 'matched', basis: 'explicit_personal_project_id', personalProjectId: 'project-b' },
    { taskContextToken: 't', personalProjectId: 'project-b', sourceApplication: 'codex', title: 'Review', objective: 'Review', idempotencyKey: 'k' }),
  { code: 'task_context_other_project', message: /begin_task_context/ });
});
