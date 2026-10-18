import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { listAgentTools } from '../src/agent-tools.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { MCP_CHAT_INSTRUCTIONS, MCP_INSTRUCTIONS } from '../src/mcp/instructions.js';
import { toolNamesForProfile } from '../src/mcp/tool-profiles.js';

test('MCP instructions support task identity, hook context and an exact fallback within 2KiB', () => {
  assert.ok(Buffer.byteLength(MCP_INSTRUCTIONS, 'utf8') <= 2048);
  assert.match(MCP_INSTRUCTIONS, /Final replies MUST copy agent_receipt.markdown unchanged once/);
  assert.match(MCP_INSTRUCTIONS, /each user task/i);
  assert.match(MCP_INSTRUCTIONS, /begin_task_context/i);
  assert.match(MCP_INSTRUCTIONS, /hook-provided task context/i);
  assert.match(MCP_INSTRUCTIONS, /get_collaboration_preferences/);
  assert.match(MCP_INSTRUCTIONS, /else.*call exactly get_collaboration_preferences/is);
  assert.match(MCP_INSTRUCTIONS, /never substitute.*project action/i);
  assert.match(MCP_INSTRUCTIONS, /else before tools\/answer call exactly/is);
  assert.match(MCP_INSTRUCTIONS, /projectPath=cwd/i);
  assert.match(MCP_INSTRUCTIONS, /taskPrompt=current user request/i);
  assert.match(MCP_INSTRUCTIONS, /effective_preferences/i);
  assert.match(MCP_INSTRUCTIONS, /personal-global everywhere/i);
  assert.match(MCP_INSTRUCTIONS, /writes?.*actual payload/i);
  assert.match(MCP_INSTRUCTIONS, /final text.*not compliance/i);
  assert.match(MCP_INSTRUCTIONS, /get_user_taste_skill/);
  assert.match(MCP_INSTRUCTIONS, /never replaces user Skill/i);
  assert.match(MCP_INSTRUCTIONS, /never guess personalProjectId/i);
  assert.match(MCP_INSTRUCTIONS, /search_current_project_knowledge/i);
  assert.match(MCP_INSTRUCTIONS, /task_knowledge_recall/i);
  assert.match(MCP_INSTRUCTIONS, /stable project fact\/method/i);
  assert.match(MCP_INSTRUCTIONS, /focused action\/artifact\/target\/ID queries/i);
  assert.match(MCP_INSTRUCTIONS, /never only the full request/i);
  assert.match(MCP_INSTRUCTIONS, /search_knowledge_graph/i);
  assert.match(MCP_INSTRUCTIONS, /search_connected_knowledge/i);
  assert.match(MCP_INSTRUCTIONS, /agent_decide.*response-only/i);
  assert.match(MCP_INSTRUCTIONS, /active child.*inheritable parent/is);
  assert.match(MCP_INSTRUCTIONS, /checkpoint_task_knowledge/i);
  assert.match(MCP_INSTRUCTIONS, /capture_candidates.*retain_nothing/is);
  assert.match(MCP_INSTRUCTIONS, /record_decision_trace/i);
  assert.match(MCP_INSTRUCTIONS, /record_knowledge_feedback/i);
  assert.match(MCP_INSTRUCTIONS, /match.*candidate only/i);
  assert.match(
    MCP_INSTRUCTIONS,
    /If supported.*sourceMarker.*else.*noMatchSourceMarker/is
  );
  assert.match(
    MCP_INSTRUCTIONS,
    /MUST begin.*sourceMarker\.leadMarkdown.*append.*sourceMarker\.markdown/is
  );
  assert.match(MCP_INSTRUCTIONS, /noMatchSourceMarker.*empty/is);
  assert.match(MCP_INSTRUCTIONS, /Keep unchanged/i);
  assert.match(MCP_INSTRUCTIONS, /executionSummary/);
  assert.match(MCP_INSTRUCTIONS, /one .*row.*worker|one .*line.*worker/i);
  assert.match(MCP_INSTRUCTIONS, /occupation.*emoji/i);
  assert.match(MCP_INSTRUCTIONS, /actual.*executor.*sourceApplication|sourceApplication.*actual/i);
  assert.match(MCP_INSTRUCTIONS, /configured.*(?:allowed|available).*not.*evidence/i);
  assert.match(MCP_INSTRUCTIONS, /executionSummary:.*Empty: omit/is);
  assert.match(MCP_INSTRUCTIONS, /coordinate_project_agent_task/);
  assert.match(MCP_INSTRUCTIONS, /Fuli never spawns/i);
  assert.match(MCP_INSTRUCTIONS, /release_runtime_lease.*finally/i);
  assert.match(MCP_INSTRUCTIONS, /project_management_context: authorized manager\+board/i);
  assert.match(MCP_INSTRUCTIONS, /keep specialist; no excluded projects\/extra model/i);
  assert.match(MCP_INSTRUCTIONS, /current native session, host tool, protect manual titles/i);
  assert.match(MCP_INSTRUCTIONS, /receipt after client result/i);
  assert.match(MCP_INSTRUCTIONS, /all workerStatus terminal/i);
  assert.match(MCP_INSTRUCTIONS, /source-labelled cumulative tokens/i);
  assert.match(MCP_INSTRUCTIONS, /Missing token usage=-.*never invent\/estimate\/copy totals/i);
});

test('chat instructions name only tools the chat profile lists', () => {
  const listed = new Set([...toolNamesForProfile('chat'), 'fuli_call']);
  const unlisted = listAgentTools().map(({ name }) => name).filter(name => !listed.has(name) && name !== 'list_agent_interfaces');
  // Mentioning an unlisted tool sent clients to discovery before every task.
  assert.deepEqual(unlisted.filter(name => new RegExp(`\\b${name}\\b`).test(MCP_CHAT_INSTRUCTIONS)), []);
  for (const pattern of [/Final replies MUST copy agent_receipt.markdown unchanged once/, /else before tools\/answer call exactly get_collaboration_preferences/,
    /projectPath=cwd/, /taskPrompt=current user request/, /never guess personalProjectId/, /writes=actual payload/, /task_knowledge_recall/,
    /search_current_project_knowledge/, /search_knowledge_graph/, /checkpoint_task_knowledge/, /retain_nothing/, /capture_candidates/,
    /list_agent_interfaces.*fuli_call/, /executionSummary/, /MUST begin sourceMarker.leadMarkdown/, /noMatchSourceMarker/]) {
    assert.match(MCP_CHAT_INSTRUCTIONS, pattern);
  }
});

test('each profile sends its own instructions', async () => {
  for (const [profile, expected] of [['chat', MCP_CHAT_INSTRUCTIONS], ['full', MCP_INSTRUCTIONS]]) {
    const server = createMcpServer({}, { env: {}, toolProfile: profile, registerResources: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'instructions', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    assert.equal(client.getInstructions(), expected, profile);
    await client.close();
  }
});
