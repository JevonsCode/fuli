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

test('MCP exposes proposal inspection but no Agent-side decision write', async () => {
  const preview = GRAPH_TOOL_DEFINITIONS.find(
    ({ name }) => name === 'preview_personal_global_preference_decision'
  );
  const apply = GRAPH_TOOL_DEFINITIONS.find(
    ({ name }) => name === 'apply_personal_global_preference_decision'
  );
  const directScope = GRAPH_TOOL_DEFINITIONS.find(
    ({ name }) => name === 'set_personal_preference_scope'
  );
  assert.match(preview.title, /^READ/);
  assert.match(preview.description, /does not mint an approval token/i);
  assert.match(preview.description, /independent human-review/i);
  assert.equal(apply, undefined);
  assert.equal(directScope, undefined);

  const calls = [];
  const app = {
    getAgentAccessPolicy: () => ({ enabled: true }),
    previewPersonalGlobalPreferenceDecision: async (input) => {
      calls.push(['preview', input]);
      return { status: 'human_review_required', approval_token_issued: false };
    }
  };
  const input = decisionInput();
  const inspected = await dispatchGraphTool(
    app,
    'preview_personal_global_preference_decision',
    input
  );
  assert.equal(inspected.approval_token_issued, false);
  assert.deepEqual(calls.map(([name]) => name), ['preview']);
  assert.throws(
    () => dispatchGraphTool(
      app,
      'apply_personal_global_preference_decision',
      { ...input, previewToken: 'human-issued-one-time-token-value-1234567890' }
    ),
    /Unknown agent tool/
  );
});

function decisionInput() {
  return {
    personalSpaceId: 'personal-1',
    candidateId: 'personal-global-1234567890abcdef1234',
    candidateVersion: 'v1:1234567890abcdef12345678',
    decisionRevision: 0,
    decision: 'reject',
    sourceItems: [
      { itemId: 'preference-d', itemKind: 'entity', projectId: 'travel-d' },
      { itemId: 'preference-e', itemKind: 'entity', projectId: 'preference-e' }
    ],
    preferenceKey: 'alignment.comments.explain-function',
    targetScope: 'personal_global',
    targetProjectId: null,
    profileAspect: null,
    globalTitle: null,
    globalInstruction: null,
    humanConfirmationReason: '用户通过独立审查拒绝此次范围提升。',
    confirmedAt: '2026-08-03T12:00:00.000Z',
    sessionId: 'scope-review-1',
    idempotencyKey: 'personal-global-reject-scope-review-1'
  };
}
