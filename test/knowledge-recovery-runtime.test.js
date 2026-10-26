import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { openFederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { hardDeleteLedger } from '../src/knowledge-hard-delete/delete-ledger.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';

const SPACE = 'synthetic-runtime-space';
const DELETED_AT = '2026-10-23T00:00:00Z';
const EMPTY = { count: 0, latest_deleted_at: null };
const DELETED = { count: 1, latest_deleted_at: DELETED_AT };

function fixture(t, initial = EMPTY) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-recovery-runtime-'));
  let watermark = initial;
  const calls = [];
  const app = openFederatedGraphApplication({ runtimeConfigPath: join(dataDir, 'graph-runtime.json'), env: {},
    config: { version: 1, workspaces: [], personal: { spaceId: SPACE, principalId: 'synthetic-person',
      providerUrl: 'http://127.0.0.1:1', accessToken: 'synthetic-agent-token' } },
    fetchImpl: async (url, request) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(request.body);
      calls.push({ path, body });
      assert.equal(request.headers.authorization, 'Bearer synthetic-agent-token');
      assert.equal(request.headers['x-fuli-human-review-token'], undefined);
      if (path === '/v1/knowledge/hard-deletions/watermark') {
        assert.deepEqual(body, { personal_space_id: SPACE });
        if (watermark instanceof Error) throw watermark;
        return Response.json(watermark);
      }
      assert.equal(path, '/v1/project-agent-score-card/evidence', 'no models or other Provider calls');
      assert.deepEqual(body.review_verdicts, []);
      return Response.json({ personal_space_id: SPACE, agent_id: 'synthetic-agent', personal_project_ids: null,
        dimension: 'review', executor_id: null, passed: { count: 0, task_ids: [] },
        not_passed: { count: 0, task_ids: [] }, truncated: false });
    }
  });
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { app, dataDir, calls, ledger: hardDeleteLedger(dataDir), graph: value => { watermark = value; } };
}

async function mcpCall(server, name, args) {
  return server.server._requestHandlers.get('tools/call')({ method: 'tools/call',
    params: { name, arguments: args } }, { signal: new AbortController().signal, requestId: 1 });
}

test('real application refuses unverified local bodies as HTTP 503 and a structured MCP recovery error', async t => {
  const f = fixture(t, DELETED);
  await assert.rejects(f.app.judgment.records({ personalSpaceId: SPACE }), error => {
    assert.equal(error.code, 'knowledge_recovery_pending');
    assert.equal(mapHttpError(error).status, 503);
    assert.equal(mapHttpError(error).body.code, 'knowledge_recovery_pending');
    return true;
  });
  const server = createMcpServer(f.app, { env: {}, toolNames: ['list_judgments'], registerResources: false });
  t.after(() => server.close());
  const refused = await mcpCall(server, 'list_judgments', { personalSpaceId: SPACE });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, 'knowledge_recovery_pending');
  assert.match(refused.structuredContent.error.message, /console checks again by itself/);
  assert.doesNotMatch(refused.structuredContent.error.message, /fuli [a-z]/);
  assert.equal(refused.structuredContent.records, undefined);
  const pins = await callAgentTool(f.app, 'get_agent_pins', { personalSpaceId: SPACE });
  assert.ok(pins.agentIds.length, 'opaque IDs remain readable while body recovery is closed');

  f.graph(EMPTY);
  const ready = await mcpCall(server, 'list_judgments', { personalSpaceId: SPACE });
  assert.notEqual(ready.isError, true);
  assert.deepEqual(ready.structuredContent.records, []);
  // Boundary and service share the same proof: just one graph read per call.
  assert.equal(f.calls.length, 3);
});

test('clean installation opens on first direct service use and shares proof with Agent calls', async t => {
  const f = fixture(t);
  const pins = await f.app.judgment.pins({ personalSpaceId: SPACE });
  assert.ok(pins.agentIds.length);
  assert.equal(f.calls.length, 0, 'ID-only reads need no graph proof');
  await f.app.judgment.policy({ personalSpaceId: SPACE });
  const records = await callAgentTool(f.app, 'list_judgments', { personalSpaceId: SPACE });
  assert.deepEqual(records.records, []);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(f.app.knowledgeRecoveryGate).sort(), ['refresh', 'state']);
});

test('role runtime refuses closed writes and claims, then serves the first claim after completed cleanup', async t => {
  const f = fixture(t, DELETED);
  const request = { role: 'bole', operation: 'staffing_review', requestId: 'synthetic-request',
    scope: { personalSpaceId: SPACE, personalProjectId: null, sessionRef: null },
    versions: { evidence: 'evidence-1', policy: 'policy-1' }, instructions: 'Choose a synthetic reviewer.',
    evidence: [{ id: 'e1', personalProjectId: null, text: 'Synthetic retained evidence.' }],
    output: { type: 'choice', options: [{ id: 'one', description: 'One' }, { id: 'two', description: 'Two' }] } };
  await assert.rejects(f.app.roleWork.decide(request), { code: 'knowledge_recovery_pending', status: 503 });
  f.graph(EMPTY);
  const pending = await f.app.roleWork.decide(request);
  assert.equal(pending.status, 'pending');
  f.app.taskContextRegistry = { context: async () => ({ sessionId: 'synthetic-session', sourceApplication: 'other' }) };
  const operation = f.ledger.begin({ spaceId: SPACE, itemKind: 'entity', itemId: 'synthetic-deleted-item',
    itemIds: ['synthetic-deleted-item'], previewId: 'synthetic-preview' });
  f.ledger.update(operation.id, { state: 'graph_deleted' });
  f.graph(DELETED);
  const claim = () => callAgentTool(f.app, 'role_work', { action: 'claim', taskContextToken: 'synthetic-task' });
  await assert.rejects(claim(), { code: 'knowledge_recovery_pending' });
  f.ledger.update(operation.id, { state: 'complete' });
  f.ledger.recordWatermark(SPACE, { count: 1, latestDeletedAt: DELETED_AT });
  const claimed = await claim();
  assert.equal(claimed.workPackage.packageId, pending.workPackage.packageId);
  assert.deepEqual(claimed.workPackage.evidence, [{ id: 'e1', text: 'Synthetic retained evidence.' }]);
});

test('score evidence waits for local verdict verification before calling the Provider', async t => {
  const f = fixture(t, new Error('synthetic offline'));
  const input = { personalSpaceId: SPACE, agentId: 'synthetic-agent', dimension: 'review' };
  await assert.rejects(callAgentTool(f.app, 'get_agent_score_card', input), { code: 'knowledge_recovery_pending' });
  assert.ok(f.calls.every(call => call.path.endsWith('/watermark')));
  f.graph(EMPTY);
  const result = await callAgentTool(f.app, 'get_agent_score_card', input);
  assert.deepEqual(result.passed, { count: 0, taskIds: [] });
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/knowledge/hard-deletions/watermark',
    '/v1/knowledge/hard-deletions/watermark', '/v1/project-agent-score-card/evidence']);
});

test('Agent boundary checks scope before recovery and leaves unrelated tools available while closed', async t => {
  const f = fixture(t, DELETED);
  assert.throws(() => callAgentTool(f.app, 'list_judgments', { personalSpaceId: 'foreign-space' }),
    { code: 'scope_mismatch', status: 403 });
  assert.equal(f.calls.length, 0);
  f.app.getGraphitiStatus = async () => ({ synthetic: 'available' });
  assert.deepEqual(await callAgentTool(f.app, 'get_graphiti_status'), { synthetic: 'available' });
  assert.equal(f.calls.length, 0);
});

test('claiming in a verified space does not expire packages in another closed space', async t => {
  const f = fixture(t);
  const request = { role: 'bole', operation: 'staffing_review', requestId: 'synthetic-own',
    scope: { personalSpaceId: SPACE, personalProjectId: null, sessionRef: null },
    versions: { evidence: 'e1', policy: 'p1' }, instructions: 'Synthetic choice.',
    evidence: [{ id: 'e1', personalProjectId: null, text: 'Synthetic.' }],
    output: { type: 'choice', options: [{ id: 'one', description: 'One' }, { id: 'two', description: 'Two' }] } };
  const pending = await f.app.roleWork.decide(request);
  const seed = new RoleWorkStore(join(f.dataDir, 'role-work.sqlite'), { recoveryGate: { state: () => ({ state: 'open' }) } });
  const foreign = seed.create({ request: { ...request, requestId: 'synthetic-foreign',
    scope: { ...request.scope, personalSpaceId: 'foreign-space' } }, reason: 'no_model',
    at: new Date('2020-01-01T00:00:00Z'), ttlMs: 1 });
  f.app.taskContextRegistry = { context: async () => ({ sessionId: 'synthetic-session', sourceApplication: 'other' }) };
  try {
    const claimed = await callAgentTool(f.app, 'role_work', { action: 'claim', taskContextToken: 'synthetic-task' });
    assert.equal(claimed.workPackage.packageId, pending.workPackage.packageId);
    assert.equal(seed.get(foreign.packageId).status, 'pending', 'unrelated space was not changed');
    assert.equal(f.calls.length, 1, 'only the active space needed proof');
  } finally { seed.close(); }
});
