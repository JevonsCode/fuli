import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { beginTaskFromPreferences } from '../src/graphiti/agent-knowledge-workflows.js';
import { ProviderTaskContextRegistry } from '../src/mcp/provider-task-context-registry.js';

test('two routine entries through chat MCP need no checkpoint call and keep the current entry receipt', async () => {
  const calls = [];
  const application = { config: { personal: { spaceId: 'synthetic-space' } },
    taskContextRegistry: new ProviderTaskContextRegistry({ beginTaskContext: async input => {
      calls.push(input);
      return { ...input, routine_auto_close_eligible: true, checkpoint: null };
    } }, 'synthetic-space') };
  application.getCollaborationPreferences = input => beginTaskFromPreferences(application, {
    context: { personal_space_id: 'synthetic-space', personal_project_id: null, project_agent_id: null },
    effective_preferences: [], preferences_complete: true,
    agent_receipt: { required: true, markdown: 'FULI Agent: current synthetic owner' }
  }, input);
  const server = createMcpServer(application, { toolProfile: 'chat', registerResources: false,
    env: { CODEX_THREAD_ID: '12345678-1234-1234-1234-123456789abc' } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'synthetic-lazy-entry', version: '1' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const entries = [];
    for (const taskPrompt of ['Synthetic first routine task', 'Synthetic second routine task']) {
      const result = await client.callTool({ name: 'get_collaboration_preferences',
        arguments: { projectPath: '/synthetic/project', taskPrompt } });
      assert.equal(result.isError, undefined);
      const entry = result.structuredContent;
      assert.equal(entry.checkpoint_required, false);
      assert.equal(entry.agent_receipt.markdown, 'FULI Agent: current synthetic owner');
      entries.push(entry.taskContextToken);
    }
    assert.notEqual(entries[0], entries[1]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(input => input.session_id === '12345678-1234-1234-1234-123456789abc'));
  } finally {
    await client.close();
    await server.close();
  }
});

test('unknown Provider eligibility keeps the explicit checkpoint requirement', async () => {
  for (const value of [undefined, false, 'true']) {
    const app = { config: { personal: { spaceId: 's' } },
      taskContextRegistry: new ProviderTaskContextRegistry({ beginTaskContext: async input => ({
        ...input, routine_auto_close_eligible: value, checkpoint: null
      }) }, 's') };
    const entry = await beginTaskFromPreferences(app, {
      context: { personal_project_id: null, project_agent_id: null }, effective_preferences: []
    }, { sessionId: 'synthetic', sourceApplication: 'codex' });
    assert.equal(entry.checkpoint_required, true);
  }
});
