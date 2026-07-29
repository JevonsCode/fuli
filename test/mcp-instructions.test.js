import assert from 'node:assert/strict';
import test from 'node:test';

import { MCP_INSTRUCTIONS } from '../src/mcp/instructions.js';

test('MCP instructions require task-scoped preference loading within the 2KB budget', () => {
  assert.ok(Buffer.byteLength(MCP_INSTRUCTIONS, 'utf8') <= 2048);
  assert.match(MCP_INSTRUCTIONS, /each user task/i);
  assert.match(MCP_INSTRUCTIONS, /get_collaboration_preferences/);
  assert.match(MCP_INSTRUCTIONS, /before other tools\/answer/i);
  assert.match(MCP_INSTRUCTIONS, /projectPath=cwd/i);
  assert.match(MCP_INSTRUCTIONS, /all effective_preferences/i);
  assert.match(MCP_INSTRUCTIONS, /personal-global everywhere/i);
  assert.match(MCP_INSTRUCTIONS, /writes?.*actual payload/i);
  assert.match(MCP_INSTRUCTIONS, /final text.*not compliance/i);
  assert.match(MCP_INSTRUCTIONS, /never guess personalProjectId/i);
});
