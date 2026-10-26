import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudgmentService } from '../src/judgment/service.js';
import { createJudgmentEngine, fingerprint } from '../src/judgment/engine.js';
import { MODEL_ANSWER, trustedTonborg } from './fixtures/model-trust.js';
import { getCollaborationPreferences } from '../src/graphiti/collaboration-preference-workflow.js';
import { completePreferences } from './fixtures/collaboration-preferences.js';

const rule = (id, instruction, extra = {}) => ({ id, item_kind: 'entity', preference_key: id, title: id, instruction,
  preference_scope: 'global', confirmation_status: 'confirmed', reasoning_summary: 'Full body the judge never needs', ...extra });
const candidate = { candidate_key: 'entity:one', title: 'Build command', content: 'npm test', confirmation_status: 'confirmed', reasons: [], project_ids: ['p'] };
const review = { personalSpaceId: 's', personalProjectId: 'p', requestId: 'review-1', limit: 10 };
const routing = { personalSpaceId: 's', personalProjectId: 'p', agentId: 'a', requestId: 'route-1', workKind: 'review', objective: 'Check artifact' };
const acceptance = { personalSpaceId: 's', personalProjectId: 'p', requestId: 'accept-1', taskId: 't', taskContextToken: 'token',
  artifactRevision: 'artifact-a', expectedRevision: 2, sourceApplication: 'codex' };

function fixture(t, preferences) {
  const prompts = [], requests = [], writes = [];
  const task = { taskId: 't', personalProjectId: 'p', leadAgentId: 'lead', status: 'awaiting_review', revision: 2, title: 'Release notes', objective: 'Publish release notes' };
  const app = { config: { personal: { spaceId: 's' } }, getCapturePolicy: () => ({ enabled: true }), listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }],
    employees: { authorize: async () => ({}) },
    getCollaborationPreferences: async request => {
      requests.push(request);
      return typeof preferences === 'function' ? preferences(request) : structuredClone(preferences);
    },
    inspectProjectAgentMemory: async () => ({ revision: 0 }),
    startKnowledgeReview: async () => ({ review_id: 'review' }), finishKnowledgeReview: async () => ({}),
    listKnowledgeReviewCandidates: async () => ({ candidates: writes.length ? [] : [structuredClone(candidate)], total_candidate_count: writes.length ? 0 : 1 }),
    recordKnowledgeReviewProgress: async input => { writes.push(input); return { outcome: input.outcome }; },
    getProjectAgent: async () => ({ profile: { allowedClients: ['codex'], executorPolicy: { mode: 'flexible' } } }),
    listExecutors: async () => [{ executorId: 'worker', displayName: 'worker', executorKind: 'codex', registrationStatus: 'registered',
      permissionStatus: 'authorized', preflightStatus: 'passed', workspacePermission: true, availableModels: [{ model: 'model', available: true }] }],
    listExecutorRoutingRules: async () => [],
    taskContextRegistry: { context: async () => ({ personalProjectId: 'p', projectAgentId: 'lead', sessionId: 'host-session',
      preferenceScope: { version: 1, work_kind: 'release', workflow: 'publication' } }) },
    viewProjectAgentTask: async () => task,
    agentVerification: async () => ({ status: 'passed', artifact_revision: 'artifact-a', verified_attempt_id: 'attempt',
      verified_attempt: { attempt_id: 'attempt', artifact_revision: 'artifact-a', outcome: 'pass', verifier_id: 'reviewer', run_id: 'run', evidence_refs: ['report'] } }),
    recordProjectAgentTaskActivity: async value => { writes.push(value); task.status = 'completed'; task.revision++; return { ...task }; } };
  const judge = async ({ prompt }) => {
    prompts.push(prompt);
    const data = JSON.parse(prompt.split('\nDATA:\n')[1]);
    const body = data.candidates
      ? { decisions: data.candidates.map(c => ({ target: c.candidate_key, outcome: 'approve', summary: 'Routine', evidence: ['Scoped content'], confidence: 0.95 })) }
      : data.eligible ? { executorId: 'worker', model: 'model', disposition: 'delegate', conversationId: null, summary: 'Bounded work', evidence: ['Eligible'] }
        : { outcome: 'approve', summary: 'Verified', evidence: ['report'], confidence: 0.95 };
    // The review write-back cases need Tonborg's configured model trusted (rec#10 D-36).
    return { ...MODEL_ANSWER, client: 'codex', body: JSON.stringify(body) };
  };
  const service = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge, trust: trustedTonborg() }) });
  service.store().setPolicy('s', '', { mode: 'shared', quality: 'quality', client: 'codex' }, 0);
  t.after(() => service.close());
  const judged = () => JSON.parse(prompts.at(-1).split('\nDATA:\n')[1]).preferences;
  return { service, prompts, requests, writes, judged };
}

test('the judge sees conflicting rules that are not effective, not an empty rule set (G7-3)', async t => {
  const left = rule('left', 'Write release notes in English', { preference_key: 'notes-language' });
  const right = rule('right', 'Write release notes in Chinese', { preference_key: 'notes-language', confirmation_status: 'agent_confirmed' });
  const { service, judged } = fixture(t, completePreferences({ global_preferences: [left, right],
    conflicts: [{ preference_key: 'notes-language', preference_scope: 'global', item_ids: ['left', 'right'] }] }));
  await service.review(review);
  const preferences = judged();
  assert.equal(preferences.status, 'complete');
  assert.deepEqual(preferences.selected, []);
  assert.equal(preferences.conflicts.length, 1);
  assert.equal(preferences.conflicts[0].key, 'notes-language');
  assert.deepEqual(preferences.conflicts[0].alternatives.map(item => [item.rule, item.authority]),
    [['Write release notes in English', 'confirmed'], ['Write release notes in Chinese', 'agent_confirmed']]);
  assert.doesNotMatch(JSON.stringify(preferences), /Full body/);
});

test('a large space past the candidate window holds every approval, even with a prohibition delivered (G2-4)', async t => {
  // 150 applicable rules at the shared limit of 100: the Provider delivers the
  // first 100 and flags the candidate window. A decision rule may be in the rest.
  const rules = [rule('aa-confirm-completion', 'Ask me before marking any release task complete', { profile_aspect: 'judgment_preference' }),
    ...Array.from({ length: 149 }, (_, i) => rule(`rule-${String(i).padStart(3, '0')}`, `Synthetic rule ${i}`, { profile_aspect: 'taste' }))];
  const delivered = rules.slice(0, 100);
  const application = { config: { personal: { spaceId: 's' } }, personal: { collaborationPreferences: async () => completePreferences({
    effective: delivered, task_scope_filtered: true, truncated: true,
    source_windows: { candidates_truncated: true, project_ancestors_truncated: false, queued_conflicts_truncated: false } }) } };
  const { service, prompts, writes } = fixture(t, request =>
    getCollaborationPreferences(application, { personalProjectId: request.personalProjectId }, request, async () => {}));
  const accepted = await service.accept(acceptance);
  assert.equal(accepted.outcome, 'escalate');
  assert.equal(accepted.execution.status, 'not_applied');
  assert.equal(accepted.preferenceDelivery.status, 'partial');
  assert.deepEqual(accepted.preferenceDelivery.truncated, ['candidates']);
  const routed = await service.assess(routing);
  assert.equal(routed.disposition, 'ask_user');
  assert.equal(routed.selection, null);
  assert.equal(routed.preferenceDelivery.status, 'partial');
  const reviewed = await service.review(review);
  assert.equal(reviewed.records.length, 1);
  assert.equal(reviewed.records[0].error, 'preferences_incomplete');
  assert.equal(reviewed.records[0].preferenceDelivery.status, 'partial');
  assert.match(reviewed.records[0].summary, /candidates truncated/);
  assert.equal(prompts.length, 0);
  assert.equal(writes.length, 0);
});

test('a conflict queue past its window is reported to the judge, not held, when every rule arrived', async t => {
  // The queue only annotates conflicts that are already delivered with both sides.
  const left = rule('left', 'Write release notes in English', { preference_key: 'notes-language' });
  const right = rule('right', 'Write release notes in Chinese', { preference_key: 'notes-language' });
  const tone = rule('tone', 'Keep release notes short');
  const { service, judged, writes } = fixture(t, completePreferences({ effective: [tone], global_preferences: [left, right, tone],
    conflicts: [{ preference_key: 'notes-language', preference_scope: 'global', item_ids: ['left', 'right'] }],
    queued_conflicts: [], truncated: true,
    source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: true } }));
  const accepted = await service.accept(acceptance);
  const preferences = judged();
  assert.equal(preferences.status, 'partial');
  assert.deepEqual(preferences.omitted.truncated, ['queued_conflicts']);
  assert.deepEqual(preferences.selected.map(item => item.key), ['tone']);
  assert.deepEqual(preferences.conflicts.map(item => [item.key, item.alternatives.length]), [['notes-language', 2]]);
  assert.equal(accepted.preferenceDelivery.status, 'partial');
  assert.deepEqual(accepted.preferenceDelivery.truncated, ['queued_conflicts']);
  assert.equal(accepted.execution.status, 'applied');
  assert.equal(writes.length, 1);
});

test('unreadable preferences are recorded as unavailable and never approve (G7-1)', async t => {
  const offline = () => { throw Object.assign(new Error('Provider offline'), { code: 'provider_unavailable' }); };
  for (const [preferences, reason] of [[offline, 'provider_unavailable'], [{}, 'preference_receipt_invalid']]) {
    const { service, prompts, writes } = fixture(t, preferences);
    const accepted = await service.accept(acceptance);
    assert.equal(accepted.outcome, 'escalate');
    assert.deepEqual(accepted.preferenceDelivery, { version: accepted.preferenceDelivery.version, status: 'unavailable', reason,
      scope: { work_kind: 'release', workflow: 'publication', session: 'known' } });
    const reviewed = await service.review(review);
    assert.equal(reviewed.records[0].error, 'preferences_unavailable');
    assert.equal(prompts.length, 0);
    assert.equal(writes.length, 0);
  }
});

test('a partly read receipt keeps its gap instead of reading as complete (G7-2)', async t => {
  const own = rule('tone', 'Keep release notes short');
  for (const [preferences, truncated] of [
    [completePreferences({ effective: [own], truncated: true,
      source_windows: { candidates_truncated: false, project_ancestors_truncated: true, queued_conflicts_truncated: false } }), ['project_ancestors']],
    [{ effective_preferences: [own] }, ['candidates', 'project_ancestors']]
  ]) {
    const { service, prompts, writes } = fixture(t, preferences);
    const accepted = await service.accept(acceptance);
    assert.equal(accepted.outcome, 'escalate');
    assert.equal(accepted.preferenceDelivery.status, 'partial');
    assert.deepEqual(accepted.preferenceDelivery.truncated, truncated);
    assert.equal(prompts.length, 0);
    assert.equal(writes.length, 0);
  }
});

test('a rule limited to a dimension the request did not state is scope_unknown, never effective (G5-3)', async t => {
  const release = rule('release-signoff', 'Get sign-off before publishing', { preference_qualifiers: { workflow: 'publication' } });
  const depth = rule('review-depth', 'Review line by line', { preference_qualifiers: { workKind: 'review' } });
  const plain = rule('plain', 'Keep summaries short');
  const { service, judged } = fixture(t, completePreferences({ effective: [release, depth, plain] }));
  await service.review(review);
  let preferences = judged();
  assert.deepEqual(preferences.scope, { work_kind: 'unknown', workflow: 'unknown', session: 'unknown' });
  assert.deepEqual(preferences.selected.map(item => item.key), ['plain']);
  // Keys only: a rule that does not apply sends no body (rec#15 D-27.2).
  assert.deepEqual(preferences.scope_unknown, ['release-signoff', 'review-depth']);
  assert.doesNotMatch(JSON.stringify(preferences), /sign-off before publishing|line by line/);
  await service.assess(routing);
  preferences = judged();
  assert.equal(preferences.scope.work_kind, 'review');
  assert.deepEqual(preferences.selected.map(item => item.key), ['review-depth', 'plain']);
  assert.deepEqual(preferences.scope_unknown, ['release-signoff']);
});

test('judgment passes the work kind, session and workflow it already knows', async t => {
  const { service, requests, writes } = fixture(t, completePreferences());
  const accepted = await service.accept(acceptance);
  assert.equal(accepted.execution.status, 'applied');
  assert.equal(writes.length, 1);
  assert.deepEqual(accepted.preferenceDelivery.scope, { work_kind: 'release', workflow: 'publication', session: 'known' });
  const scope = ({ sessionId, workKind, workflow }) => ({ sessionId, workKind, workflow });
  assert.deepEqual(scope(requests[0]), { sessionId: 'host-session', workKind: 'release', workflow: 'publication' });
  await service.assess(routing);
  assert.deepEqual(scope(requests.at(-1)), { sessionId: null, workKind: 'review', workflow: null });
});

test('the judge gets the task-entry projection of the real Provider read, scoped by the known work kind', async t => {
  const providerCalls = [];
  const left = rule('left', 'Write release notes in English', { preference_key: 'notes-language' });
  const right = rule('right', 'Write release notes in Chinese', { preference_key: 'notes-language' });
  const signoff = rule('release-signoff', 'Get sign-off before publishing', { preference_qualifiers: { workflow: 'publication' } });
  const provider = completePreferences({ personal_space_id: 's', personal_project_id: 'p', effective: [signoff],
    global_preferences: [left, right, signoff], task_scope_filtered: true, task_scope_excluded_count: 1,
    conflicts: [{ preference_key: 'notes-language', preference_scope: 'global', item_ids: ['left', 'right'] }] });
  const application = { config: { personal: { spaceId: 's' } }, personal: {
    collaborationPreferences: async (...args) => { providerCalls.push(args); return structuredClone(provider); } } };
  const { service, judged } = fixture(t, request =>
    getCollaborationPreferences(application, { personalProjectId: request.personalProjectId }, request, async () => {}));
  await service.assess(routing);
  assert.deepEqual(providerCalls[0], ['s', 'p', 100, 'employee.tonborg',
    { sessionId: null, sourceSessionId: null, workKind: 'review', workflow: null }]);
  const preferences = judged();
  assert.equal(preferences.status, 'complete');
  assert.deepEqual(preferences.scope_unknown, ['release-signoff']);
  assert.deepEqual(preferences.conflicts.map(item => [item.key, item.alternatives.length]), [['notes-language', 2]]);
  assert.equal(preferences.omitted.out_of_task_scope, 1);
});

test('acceptance does not complete a task when its scoped preferences changed during judgment', async t => {
  let reads = 0;
  const { service, writes } = fixture(t, () => completePreferences({
    effective: ++reads === 1 ? [] : [rule('late', 'Ask me before closing release tasks')] }));
  const accepted = await service.accept(acceptance);
  assert.equal(accepted.outcome, 'approve');
  assert.equal(accepted.execution.status, 'stale');
  assert.equal(writes.length, 0);
});

test('a review approval is not written back when its scoped preferences changed during judgment', async t => {
  const ask = rule('ask', 'Ask me before marking knowledge reviewed');
  const changes = [
    ['a rule is added', [], [ask]],
    ['a rule is removed', [ask], []],
    ['a rule changes scope', [ask], [{ ...ask, preference_scope: 'project' }]]];
  for (const [label, before, after] of changes) {
    let reads = 0;
    const { service, writes } = fixture(t, () => completePreferences({ effective: ++reads === 1 ? before : after }));
    const reviewed = await service.review(review);
    assert.equal(reads, 2, label);
    assert.equal(reviewed.records[0].outcome, 'approve', label);
    assert.equal(reviewed.records[0].execution.status, 'stale', label);
    assert.equal(writes.length, 0, label);
    assert.equal(service.store().reviewed('s', 'p', candidate.candidate_key, fingerprint(candidate),
      reviewed.records[0].policyVersion), false, label);
  }
});

test('a review approval is not written back when the second preference read fails', async t => {
  let reads = 0;
  const { service, writes } = fixture(t, () => {
    if (++reads === 1) return completePreferences();
    throw Object.assign(new Error('Provider offline'), { code: 'provider_unavailable' });
  });
  const reviewed = await service.review(review);
  assert.equal(reviewed.records[0].execution.status, 'stale');
  assert.equal(writes.length, 0);
});

test('a review judged with an older preference context is judged again, and the old record stays readable', async t => {
  const { service, prompts } = fixture(t, completePreferences());
  const policy = service.store().policy('s', 'p');
  const legacy = service.store().record('s', { personalProjectId: 'p', kind: 'review', target: candidate.candidate_key,
    outcome: 'escalate', summary: 'Judged with effective preferences only', evidence: ['old'],
    policyVersion: `${policy.revision}:${policy.globalRevision}:${policy.mode}:${policy.quality}:${policy.client}`,
    evidenceFingerprint: fingerprint(candidate) }, 'legacy-review');
  await service.review(review);
  assert.equal(prompts.length, 1);
  assert.equal(service.store().get('s', legacy.id).summary, 'Judged with effective preferences only');
});
