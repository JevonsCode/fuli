import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudgmentService } from '../src/judgment/service.js';
import { createJudgmentEngine } from '../src/judgment/engine.js';

function fixture(t, { mode = 'shared', mutate, answer } = {}) {
  const candidates = [{ candidate_key: 'entity:one', title: 'Build command', content: 'npm test', confirmation_status: 'confirmed', changed_at: '2026-01-01', reasons: [], project_ids: ['p'] }];
  const writes = [];
  const app = { config: { personal: { spaceId: 's' } },
    listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => ({ effective_preferences: [] }),
    inspectProjectAgentMemory: async () => ({ current: null, revision: 0 }),
    employees: { authorize: async () => ({}) },
    personal: {},
    startKnowledgeReview: async () => ({ review_id: 'review' }),
    finishKnowledgeReview: async () => ({}),
    listKnowledgeReviewCandidates: async () => ({ candidates, total_candidate_count: candidates.length }),
    recordKnowledgeReviewProgress: async input => { writes.push(input); candidates.shift(); return { outcome: input.outcome }; },
    listExecutors: async () => [] };
  const judge = async () => { mutate?.(candidates); return { body: JSON.stringify(answer ?? { decisions: [{ target: 'entity:one', outcome: 'approve', summary: 'Evidence supports routine review', evidence: ['Current confirmed command'], confidence: 0.95 }] }), client: 'codex', model: null, sessionId: 'fixture-session' }; };
  const service = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge }) });
  service.store().setPolicy('s', '', { mode, quality: 'quality', client: 'codex' }, 0);
  t.after(() => service.close());
  return { service, writes, candidates, app };
}
const input = { personalSpaceId: 's', personalProjectId: 'p', requestId: 'test-request-1', limit: 10 };

test('judgment initializes its authorized project scope but omits Agent scope for global preferences', async t => {
  const { service, app } = fixture(t, { mode: 'manual' });
  let assigned = false;
  app.employees.authorize = async request => { assigned = request.ensureAssignment === true; };
  app.getCollaborationPreferences = async request => {
    if (request.personalProjectId) {
      assert.equal(assigned, true);
      assert.equal(request.projectAgentId, 'employee.tonborg');
    } else assert.equal(request.projectAgentId, undefined);
    return { effective_preferences: [] };
  };
  assert.notEqual((await service.review(input)).records[0].outcome, 'failed');
  assert.notEqual((await service.review({ ...input, personalProjectId: null, requestId: 'global-scope' })).records[0].outcome, 'failed');
});

test('routine review executes AI review without forging human confirmation; retry is idempotent', async t => {
  const { service, writes } = fixture(t);
  const result = await service.review(input);
  assert.equal(result.records[0].execution.status, 'applied');
  assert.equal(writes[0].outcome, 'ai_reviewed');
  assert.equal((await service.review(input)).records[0].id, result.records[0].id);
  assert.equal(writes.length, 1);
});
test('manual mode and sensitive preference evidence remain human decisions', async t => {
  const manual = fixture(t, { mode: 'manual' });
  assert.equal((await manual.service.review(input)).records[0].execution.status, 'not_applied');
  assert.equal(manual.writes.length, 0);
  const sensitive = fixture(t);
  sensitive.candidates[0].profile_aspect = 'judgment';
  assert.equal((await sensitive.service.review(input)).records[0].outcome, 'escalate');
  assert.equal(sensitive.writes.length, 0);
});
test('changed evidence makes a decision stale before any write', async t => {
  const { service, writes } = fixture(t, { mutate: candidates => { candidates[0].content = 'Different'; } });
  assert.equal((await service.review(input)).records[0].execution.status, 'stale');
  assert.equal(writes.length, 0);
});
test('malformed or invented model targets fail closed with visible failure records', async t => {
  const { service, writes } = fixture(t, { answer: { decisions: [{ target: 'entity:invented', outcome: 'approve', summary: 'invented', evidence: [], confidence: 1 }] } });
  const result = await service.review(input);
  assert.equal(result.records[0].outcome, 'failed');
  assert.equal(writes.length, 0);
});
test('revoking Tonborg access during model evaluation prevents the review write', async t => {
  let revoke = false;
  const { service, app, writes } = fixture(t, { mutate: () => { revoke = true; } });
  app.listProjectAgents = async () => [{ agentId: 'employee.tonborg', profile: {
    status: revoke ? 'archived' : 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }];
  assert.equal((await service.review(input)).records[0].execution.status, 'failed');
  assert.equal(writes.length, 0);
});
test('a disallowed judgment client is rejected before reading memory or preferences, including global review', async t => {
  for (const personalProjectId of ['p', null]) {
    const { service, app, writes } = fixture(t);
    service.store().setPolicy('s', '', { mode: 'autonomous', quality: 'quality', client: 'claude_code' }, 1);
    app.getCollaborationPreferences = async () => { assert.fail('Unauthorized client must not receive preferences'); };
    app.inspectProjectAgentMemory = async () => { assert.fail('Unauthorized client must not receive memory'); };
    const result = await service.review({ ...input, personalProjectId });
    assert.equal(result.records[0].outcome, 'failed');
    assert.equal(result.records[0].error, 'judgment_client_forbidden');
    assert.equal(writes.length, 0);
  }
});
test('one failed candidate does not starve later review pages and is retried on the next cycle', async t => {
  const { service, app } = fixture(t);
  const all = Array.from({ length: 65 }, (_, i) => ({ candidate_key: `entity:${i}`, title: `Item ${i}`, content: `Evidence ${i}`, confirmation_status: 'confirmed', reasons: [], project_ids: ['p'] }));
  const attempted = [];
  app.listKnowledgeReviewCandidates = async ({ offset = 0, limit }) => ({ candidates: all.slice(offset, offset + limit), total_candidate_count: all.length });
  app.recordKnowledgeReviewProgress = async ({ candidateKey }) => { attempted.push(candidateKey); if (candidateKey === 'entity:0') throw new Error('fixture failure'); return { outcome: 'ai_reviewed' }; };
  const engine = createJudgmentEngine({ app, judge: async ({ prompt }) => ({ client: 'codex', body: JSON.stringify({ decisions: JSON.parse(prompt.split('\nDATA:\n')[1]).candidates.map(c => ({ target: c.candidate_key, outcome: 'approve', summary: 'Supported routine evidence', evidence: ['Scoped content'], confidence: 0.95 })) }) }) });
  for (let round = 0; round < 10; round++) await engine.review(service, { ...input, requestId: `page-${round}` });
  assert.ok(attempted.includes('entity:64'));
  assert.ok(attempted.filter(id => id === 'entity:0').length >= 2);
});
