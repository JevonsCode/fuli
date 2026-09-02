import assert from 'node:assert/strict';
import test from 'node:test';

import { MCP_INSTRUCTIONS } from '../src/mcp/instructions.js';

test('MCP instructions support hook-provided task context and an exact fallback within 2KB', () => {
  assert.ok(Buffer.byteLength(MCP_INSTRUCTIONS, 'utf8') <= 2048);
  assert.match(MCP_INSTRUCTIONS, /each user task/i);
  assert.match(MCP_INSTRUCTIONS, /begin_task_context/i);
  assert.match(MCP_INSTRUCTIONS, /hook-provided task context/i);
  assert.match(MCP_INSTRUCTIONS, /get_collaboration_preferences/);
  assert.match(MCP_INSTRUCTIONS, /else.*call exactly get_collaboration_preferences/is);
  assert.match(MCP_INSTRUCTIONS, /never substitute.*project action/i);
  assert.match(MCP_INSTRUCTIONS, /else before tools\/answer call exactly/is);
  assert.match(MCP_INSTRUCTIONS, /projectPath=cwd/i);
  assert.match(MCP_INSTRUCTIONS, /taskPrompt=current user request/i);
  assert.match(MCP_INSTRUCTIONS, /all effective_preferences/i);
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
    /If supported.*sourceMarker.*otherwise.*noMatchSourceMarker/is
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
  assert.match(MCP_INSTRUCTIONS, /project_management_context: actionable work via authorized manager\+board/i);
  assert.match(MCP_INSTRUCTIONS, /keep chosen specialist; no excluded projects\/extra model/i);
  assert.match(MCP_INSTRUCTIONS, /exact current native session, host rename tool, manual-title protection/i);
  assert.match(MCP_INSTRUCTIONS, /receipt after actual client result/i);
  assert.match(MCP_INSTRUCTIONS, /all workerStatus terminal/i);
  assert.match(MCP_INSTRUCTIONS, /source-labelled cumulative tokens/i);
  assert.match(MCP_INSTRUCTIONS, /Missing=unknown; no invent\/estimate\/copy totals/i);
});
