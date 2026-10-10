import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudgmentService } from '../src/judgment/service.js';
import { createJudgmentEngine } from '../src/judgment/engine.js';

const input = { personalSpaceId: 's', personalProjectId: 'p', requestId: 'accept-once', taskId: 't',
  taskContextToken: 'current-host-token', artifactRevision: 'artifact-a', expectedRevision: 2, sourceApplication: 'codex' };
function fixture(t, { mode = 'shared', verifier = 'reviewer', artifact = 'artifact-a', lead = 'lead', writeError } = {}) {
  const writes = [], task = { taskId: 't', personalProjectId: 'p', leadAgentId: 'lead', status: 'awaiting_review', revision: 2, title: 'Test', objective: 'Verify routine change' };
  const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }],
    taskContextRegistry: { context: async () => ({ personalProjectId: 'p', projectAgentId: lead }) },
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => ({ effective_preferences: [] }), inspectProjectAgentMemory: async () => ({}),
    viewProjectAgentTask: async () => task,
    agentVerification: async (_operation, request) => { assert.equal(request.personalSpaceId, 's'); return { status: 'passed', artifact_revision: artifact, verified_attempt_id: 'attempt',
      verified_attempt: { attempt_id: 'attempt', artifact_revision: artifact, outcome: 'pass', verifier_id: verifier, run_id: 'actual-run', evidence_refs: ['test-report'] } }; },
    recordProjectAgentTaskActivity: async value => { writes.push(value); if (writeError) throw writeError; task.status = 'completed'; task.revision++; return { ...task }; } };
  const judge = async () => ({ client: 'codex', body: JSON.stringify({ outcome: 'approve', summary: 'Verified routine result', evidence: ['test-report'], confidence: 0.95 }) });
  const service = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge }) });
  service.store().setPolicy('s', '', { mode, quality: 'quality', client: 'codex' }, 0);
  t.after(() => service.close());
  return { service, app, writes };
}
test('lead acceptance binds actual verification and is idempotent without claiming a human action', async t => {
  const { service, writes } = fixture(t);
  const first = await service.accept(input);
  assert.equal(first.execution.status, 'applied');
  assert.equal(first.execution.receipt.status, 'completed');
  assert.equal(writes[0].expectedVerificationAttemptId, 'attempt');
  assert.equal(writes[0].expectedRevision, 2);
  assert.equal(writes[0].actorKind, 'agent');
  assert.equal((await service.accept(input)).id, first.id);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(JSON.stringify(first), /current-host-token/);
});
test('manual mode, same-Agent verification and wrong artifact cannot automatically complete', async t => {
  for (const options of [{ mode: 'manual' }, { verifier: 'lead' }, { artifact: 'different' }]) {
    const { service, writes } = fixture(t, options);
    assert.equal((await service.accept(input)).execution.status, 'not_applied');
    assert.equal(writes.length, 0);
  }
});
test('non-lead context is rejected and an atomic Provider conflict remains stale', async t => {
  const other = fixture(t, { lead: 'other' });
  await assert.rejects(other.service.accept(input), { code: 'judgment_lead_required' });
  const stale = fixture(t, { writeError: Object.assign(new Error('Changed verification'), { status: 409 }) });
  assert.equal((await stale.service.accept(input)).execution.status, 'stale');
  const retried = await stale.service.accept(input);
  assert.equal(retried.execution.status, 'stale');
  assert.equal(stale.writes.length, 1);
});
test('lead authorization is rechecked after judgment before any completion write', async t => {
  const { service, app, writes } = fixture(t);
  let calls = 0;
  app.taskContextRegistry.context = async () => ({ personalProjectId: 'p', projectAgentId: ++calls === 1 ? 'lead' : 'other' });
  assert.equal((await service.accept(input)).execution.status, 'failed');
  assert.equal(writes.length, 0);
});
