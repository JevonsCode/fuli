import assert from 'node:assert/strict';
import test from 'node:test';

import { GRAPH_TOOL_DEFINITIONS } from '../src/agent-tools/graph-definitions.js';
import { dispatchGraphTool } from '../src/agent-tools/graph-handlers.js';

test('MCP exposes and routes read-only personal-global preference candidate discovery',
  async () => {
    const tool = GRAPH_TOOL_DEFINITIONS.find(
      ({ name }) => name === 'discover_personal_global_preference_candidates'
    );
    assert.ok(tool);
    assert.match(tool.title, /^READ/);
    assert.match(tool.description, /human scope judgment/i);
    assert.match(tool.description, /never.*apply|does not.*apply/i);
    assert.deepEqual(tool.inputSchema.required, [
      'personalSpaceId',
      'personalProjectIds',
      'query'
    ]);

    const calls = [];
    const result = await dispatchGraphTool({
      getAgentAccessPolicy: () => ({ enabled: true }),
      discoverPersonalGlobalPreferenceCandidates: async (input) => {
        calls.push(input);
        return { status: 'candidates_found', candidates: [] };
      }
    }, 'discover_personal_global_preference_candidates', {
      personalSpaceId: 'personal-1',
      personalProjectIds: ['travel-d', 'unrelated-f'],
      query: '注释写清楚功能'
    });

    assert.deepEqual(result, { status: 'candidates_found', candidates: [] });
    assert.deepEqual(calls, [{
      personalSpaceId: 'personal-1',
      personalProjectIds: ['travel-d', 'unrelated-f'],
      query: '注释写清楚功能'
    }]);
  });

// 11-11: the decision half was removed; discovery stays read-only.
test('MCP has no personal-global decision inspection, apply or direct scope tool', () => {
  for (const name of ['preview_personal_global_preference_decision',
    'apply_personal_global_preference_decision', 'set_personal_preference_scope']) {
    assert.equal(GRAPH_TOOL_DEFINITIONS.some((tool) => tool.name === name), false, name);
  }
});
