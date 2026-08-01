import assert from 'node:assert/strict';
import test from 'node:test';

import { MCP_INSTRUCTIONS } from '../src/mcp/instructions.js';

test('MCP instructions support hook-provided task context and an exact fallback within 2KB', () => {
  assert.ok(Buffer.byteLength(MCP_INSTRUCTIONS, 'utf8') <= 2048);
  assert.match(MCP_INSTRUCTIONS, /each user task/i);
  assert.match(MCP_INSTRUCTIONS, /begin_task_context/i);
  assert.match(MCP_INSTRUCTIONS, /hook-provided task context/i);
  assert.match(MCP_INSTRUCTIONS, /get_collaboration_preferences/);
  assert.match(MCP_INSTRUCTIONS, /otherwise.*call exactly get_collaboration_preferences/is);
  assert.match(MCP_INSTRUCTIONS, /never substitute.*project action/i);
  assert.match(MCP_INSTRUCTIONS, /before other tools\/answer.*fallback/is);
  assert.match(MCP_INSTRUCTIONS, /projectPath=cwd/i);
  assert.match(MCP_INSTRUCTIONS, /taskPrompt=current user request/i);
  assert.match(MCP_INSTRUCTIONS, /all effective_preferences/i);
  assert.match(MCP_INSTRUCTIONS, /personal-global everywhere/i);
  assert.match(MCP_INSTRUCTIONS, /writes?.*actual payload/i);
  assert.match(MCP_INSTRUCTIONS, /final text.*not compliance/i);
  assert.match(MCP_INSTRUCTIONS, /never guess personalProjectId/i);
  assert.match(MCP_INSTRUCTIONS, /search_current_project_knowledge/i);
  assert.match(MCP_INSTRUCTIONS, /task_knowledge_recall/i);
  assert.match(MCP_INSTRUCTIONS, /stable project fact or method/i);
  assert.match(MCP_INSTRUCTIONS, /focused action, artifact, target-system, or identifier queries/i);
  assert.match(MCP_INSTRUCTIONS, /never use the whole conversational request as the only query/i);
  assert.match(MCP_INSTRUCTIONS, /search_knowledge_graph/i);
  assert.match(MCP_INSTRUCTIONS, /search_connected_knowledge/i);
  assert.match(MCP_INSTRUCTIONS, /agent_decide.*response-only/i);
  assert.match(MCP_INSTRUCTIONS, /active child.*inheritable parent/is);
  assert.match(MCP_INSTRUCTIONS, /checkpoint_task_knowledge/i);
  assert.match(MCP_INSTRUCTIONS, /capture_candidates.*retain_nothing/is);
  assert.match(MCP_INSTRUCTIONS, /record_decision_trace/i);
  assert.match(MCP_INSTRUCTIONS, /record_knowledge_feedback/i);
  assert.match(MCP_INSTRUCTIONS, /On miss.*noMatchSourceMarker.*leadMarkdown only.*empty markdown/i);
});
