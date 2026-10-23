import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parse } from './service.js';
import { createJudgmentBackend, failureProvenance, judgmentAnswer, judgmentProvenance, pendingRecord,
  TONBORG_OPERATIONS } from './backend.js';
import { assessRouting } from './routing.js';
import { assessAcceptance } from './acceptance.js';
import { recoverInterruptedWrites } from './review-recovery.js';
import { EmployeeError } from '../employees/manifest.js';
import { judgmentHumanInteraction } from './conversation.js';
import { arraySchema, enumSchema, objectSchema } from '../agent-tools/schema.js';
import { VERDICT_FIELDS, verdictProperties } from './verdict-schema.js';
import { jsonSchemaToZod } from '../mcp/tool-schema.js';
import { PREFERENCE_RECEIPT_VERSION, preferenceDeliveryRecord, preferenceHold,
  readJudgmentPreferences } from './preference-receipt.js';
import { REVIEW_EXAMPLE, REVIEW_PROMPT_VERSION, REVIEW_SAMPLING, reviewInstructions } from './review-prompt.js';
import { createReviewGate } from './review-gate.js';

const id = z.string().min(1).max(256);
const reviewInput = z.object({ personalSpaceId: id, personalProjectId: id.nullable().optional(), requestId: id,
  limit: z.number().int().min(1).max(10).default(10) }).strict();
const reviewSchema = candidates => objectSchema({ decisions: arraySchema(objectSchema({
  target: enumSchema(candidates.map(candidate => candidate.candidate_key)), ...verdictProperties },
['target', ...VERDICT_FIELDS]), { minItems: candidates.length, maxItems: candidates.length }) }, ['decisions']);
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A record of this request whose execution is final is never applied again.
const SETTLED = Object.freeze(['applied', 'stale', 'failed', 'undone']);
// An approval below this confidence goes to the person.
const REVIEW_CONFIDENCE_FLOOR = 0.85;
const policyVersion = p => `${PREFERENCE_RECEIPT_VERSION}:${p.revision}:${p.globalRevision}:${p.mode}:${p.quality}:${p.client}`;

// reviewGate: which model builds may apply a review without the person
// (review-gate.js, rec#10 D-24); without one, every review is a suggestion.
export function createJudgmentEngine({ app, judge = createJudgmentBackend(), reviewGate = createReviewGate() } = {}) {
  // Every judgment call carries its bounded instructions, data and answer
  // schema, plus the prompt an opted-in legacy CLI client reads.
  const decide = async call => judgmentAnswer(await judge({ ...call, client: call.policy.client, quality: call.policy.quality,
    requestId: call.requestId.length <= 256 ? call.requestId : fingerprint(call.requestId),
    prompt: `${call.instructions} Answer ONLY JSON: ${call.example}\nDATA:\n${JSON.stringify(call.data)}`,
    evidenceVersion: fingerprint(call.data), policyVersion: policyVersion(call.policy) }));
  async function authorize(input, policy, { ensureAssignment = false } = {}) {
    const agents = await app.listProjectAgents({ personalSpaceId: input.personalSpaceId });
    const tonborg = agents.find(agent => agent.agentId === 'employee.tonborg');
    if (tonborg?.profile.status !== 'active' || !tonborg.profile.capabilities?.includes('fuli.employee:tonborg')) {
      throw new EmployeeError('Tonborg is unavailable', 403, 'judgment_agent_unavailable');
    }
    if (!tonborg.profile.allowedClients?.includes(policy.client)) {
      throw new EmployeeError('Tonborg is not enabled for the selected judgment client', 403, 'judgment_client_forbidden');
    }
    if (input.personalProjectId && app.employees) await app.employees.authorize({ templateId: 'tonborg', ...input, sourceApplication: policy.client, ensureAssignment });
  }
  // taskScope carries only the work kind, session and workflow the caller actually knows.
  const readPreferences = (project, taskScope = {}) => readJudgmentPreferences(app, { personalProjectId: project,
    projectAgentId: project ? 'employee.tonborg' : null, taskScope });
  async function context(service, input, policy = service.store().policy(input.personalSpaceId, input.personalProjectId ?? ''), taskScope = {}) {
    const project = input.personalProjectId ?? null;
    await authorize(input, policy, { ensureAssignment: true });
    const preferences = await readPreferences(project, taskScope);
    let memory = null;
    if (project) {
      try { memory = await app.inspectProjectAgentMemory({ personalSpaceId: input.personalSpaceId, personalProjectId: project, agentId: 'employee.tonborg', limit: 1 }); }
      catch (error) { if (![403, 404].includes(error.status)) throw error; }
    }
    return { preferences, memory: memory?.current?.memory ?? null,
      memoryRevision: memory?.revision ?? null,
      feedback: service.store().records(input.personalSpaceId, { personalProjectId: project, limit: 30 })
        .filter(r => r.feedback.vote !== null || r.feedback.reason).map(r => ({ id: r.id, kind: r.kind,
          target: r.target, workKind: r.workKind, objective: r.objective, selection: r.selection,
          disposition: r.disposition, summary: r.summary, feedback: r.feedback })) };
  }
  // execution: the role_work execution applying a session answer, if any.
  async function review(service, raw, { localOnly = false, execution = null } = {}) {
    const input = parse(reviewInput, raw); await service.scope(input);
    if (!input.personalProjectId && !localOnly) return reviewAcrossScopes(service, input);
    const space = input.personalSpaceId, project = input.personalProjectId ?? '';
    const store = service.store(), cacheKey = `review:${project}:${input.requestId}`;
    const saved = store.setting(space, cacheKey).value;
    if (saved) {
      const records = saved.recordIds.map(id => store.get(space, id));
      return { ...judgmentHumanInteraction(records, space), ...saved, records };
    }
    const token = store.claim(space, project), lease = { project, token };
    const records = [];
    let run, cursor, page, offset, candidates = [], visited, evidenceContext, hold, handedOff = false;
    const cursorKey = `review-offset:${project}`, visitedKey = `review-visited:${project}`;
    try {
      const policy = store.policy(space, project);
      evidenceContext = await context(service, input, policy);
      hold = preferenceHold(evidenceContext.preferences);
      // Defer rather than escalate every candidate: they stay queued for a later cycle.
      if (hold) throw Object.assign(new Error(hold.summary), { code: hold.error });
      run = await app.startKnowledgeReview({ personalSpaceId: space, personalProjectId: project || null, scope: project ? 'project' : 'preferences_global', reviewer: 'tonborg' });
      cursor = store.setting(space, cursorKey);
      offset = cursor.value ?? 0;
      visited = store.setting(space, visitedKey);
      page = await app.listKnowledgeReviewCandidates({ personalSpaceId: space, reviewId: run.review_id, limit: 50, offset });
      // A previous human-needed decision remains in its queue; do not repeatedly
      // spend a model call reviewing unchanged evidence. A new version is eligible.
      // This request's own records do not count: a rerun after an interrupted
      // run (rec#8 C11) settles them first and finishes the rest, and
      // store.record returns the same record.
      const recovered = await recoverInterruptedWrites({ app, store, space, requestKey: cacheKey, lease });
      candidates = structuredClone((page.candidates ?? []).filter(candidate => !(visited.value ?? []).includes(fingerprint(candidate))
        && !store.reviewed(space, project, candidate.candidate_key, fingerprint(candidate), policyVersion(policy), { exceptRequest: cacheKey })).slice(0, input.limit));
      records.push(...recovered.filter(record => !candidates.some(candidate => candidate.candidate_key === record.target)));
      if (candidates.length) {
        const schema = reviewSchema(candidates);
        const answer = await decide({ policy, operation: TONBORG_OPERATIONS.review, requestId: cacheKey, resume: input,
          scope: { personalSpaceId: space, personalProjectId: project || null }, instructions: reviewInstructions(policy),
          example: REVIEW_EXAMPLE, schema, data: { policy, ...evidenceContext, candidates }, execution });
        // A handed-off review leaves its candidates unvisited for the session's answer.
        if (answer.pending) {
          handedOff = true;
          records.push(store.record(space, { personalProjectId: project || null, kind: 'review', target: 'review', title: 'Tonborg review',
            ...pendingRecord(answer), policy }, `pending:${answer.pending.packageId}`));
        }
        const gate = answer.pending ? null : reviewGate.status(reviewGateKey(answer));
        for (const decision of answer.pending ? [] : reviewDecisions(answer.value, schema, candidates)) {
          const candidate = candidates.find(c => c.candidate_key === decision.target);
          // The person may have permanently deleted it while the model answered (rec#5 C9).
          if (store.forgets(decision.target)) continue;
          const protectedItem = Boolean(candidate.requires_attention || candidate.negative_evidence_count > 0
            || candidate.reasons?.includes('conflict_or_attention'));
          const aiReview = reviewDisposition(decision, { protectedItem, gate, policy });
          const outcome = aiReview.interceptions.some(reason => reason !== 'manual_policy') ? 'escalate' : decision.outcome;
          let record = store.record(space, { personalProjectId: project || null, kind: 'review', target: decision.target,
            title: candidate.title, summary: decision.summary, evidence: decision.evidence, confidence: decision.confidence,
            outcome, aiReview, policy, policyVersion: policyVersion(policy), evidenceFingerprint: fingerprint(candidate),
            memoryRevision: evidenceContext.memoryRevision, preferenceDelivery: preferenceDeliveryRecord(evidenceContext.preferences),
            ...judgmentProvenance(answer) }, `${cacheKey}:${decision.target}`);
          // Already settled by an interrupted run of this request: never apply twice.
          if (SETTLED.includes(record.execution.status)) { records.push(record); continue; }
          // A rerun applies a stored decision only while the gate still passes now.
          if (record.aiReview?.state === 'ai_reviewed' && aiReview.state === 'ai_reviewed') {
            const current = await app.listKnowledgeReviewCandidates({ personalSpaceId: space, reviewId: run.review_id, limit: 50, offset: Math.max(0, offset - records.filter(r => r.execution.status === 'applied').length) });
            const fresh = current.candidates.find(c => c.candidate_key === decision.target);
            if (!fresh || fingerprint(fresh) !== fingerprint(candidate) || policyVersion(store.policy(space, project)) !== policyVersion(policy)) {
              record = store.execute(space, record.id, 'stale', { reason: 'Evidence or policy changed. Review again.' }, lease);
            } else if (fingerprint(await readPreferences(project || null)) !== fingerprint(evidenceContext.preferences)) {
              // The approval was judged against the receipt it saw; a changed or unreadable receipt defers the write.
              record = store.execute(space, record.id, 'stale', { reason: 'Scoped preferences changed. Review again.' }, lease);
            } else {
              try {
                await authorize(input, policy);
                // The person may remove the build's entry while this batch runs, so the gate is read again
                // right before each write; a refusal is stale and the next review makes it a suggestion.
                if (reviewGate.status(reviewGateKey(answer)).status !== 'passed') throw Object.assign(new Error('gate_not_passed'), { status: 409, code: 'gate_not_passed' });
                // The intent is stored before the Provider write, so a restart settles it (rec#8 C11).
                record = store.execute(space, record.id, 'applying', { reviewId: run.review_id, candidateKey: decision.target,
                  aiReviewEvidenceToken: candidate.ai_review_evidence_token }, lease);
                const receipt = await app.recordKnowledgeReviewProgress({ personalSpaceId: space, reviewId: run.review_id,
                  candidateKey: decision.target, outcome: 'ai_reviewed', aiReviewEvidenceToken: candidate.ai_review_evidence_token,
                  aiAssessment: { outcome: 'approve', summary: decision.summary, evidence: decision.evidence, confidence: decision.confidence,
                    client: answer.client, model: answer.model ?? null, session_id: answer.sessionId ?? null },
                  note: `Tonborg ${record.id}: ${decision.summary}`.slice(0, 2000) });
                record = store.execute(space, record.id, 'applied', { reviewId: run.review_id, outcome: receipt.outcome }, lease);
              } catch (error) {
                if (!store.owns(space, project, token)) throw error;
                record = store.execute(space, record.id, error.status === 409 ? 'stale' : 'failed', { reason: error.code ?? 'review_write_failed' }, lease);
              }
            }
          }
          records.push(record);
        }
      }
      const remaining = Math.max(0, (page.total_candidate_count ?? 0) - records.filter(r => r.execution.status === 'applied').length);
      const result = { recordIds: records.map(r => r.id), remaining };
      if (!handedOff) store.writeSetting(space, cacheKey, result, 0);
      return { ...judgmentHumanInteraction(records, space), records, remaining };
    } catch (error) {
      // A run that lost its scope to a newer one records nothing, so the
      // owner's result stands; an unconfirmed interrupted write waits for a retry.
      if (error.retryable || !store.owns(space, project, token)) throw error;
      const record = store.record(space, { personalProjectId: project || null, kind: 'review', target: 'review', outcome: 'failed',
        summary: hold?.summary ?? 'Tonborg could not complete this review.', evidence: [], error: error.code ?? 'judgment_failed',
        ...(evidenceContext ? { preferenceDelivery: preferenceDeliveryRecord(evidenceContext.preferences) } : {}),
        ...failureProvenance(error), policy: store.policy(space, project) }, `${cacheKey}:failure`);
      return { ...judgmentHumanInteraction(records, space), records: [...records, record], remaining: null };
    } finally {
      // Only the run that still holds the scope moves the queue and closes the Provider run.
      const owner = store.owns(space, project, token);
      try {
        if (page && owner) {
          // Failed items stay retryable, but only once per pagination cycle.
          // They must not starve later pages of unrelated work.
          const attempted = new Set([...(visited.value ?? []), ...(handedOff ? [] : candidates.map(fingerprint))]);
          const currentPolicy = policyVersion(store.policy(space, project));
          const moreOnPage = page.candidates.some(candidate => !attempted.has(fingerprint(candidate))
            && !store.reviewed(space, project, candidate.candidate_key, fingerprint(candidate), currentPolicy));
          store.writeSetting(space, visitedKey, moreOnPage ? [...attempted] : [], visited.revision);
          store.writeSetting(space, cursorKey, moreOnPage ? offset : offset + 50 < page.total_candidate_count ? offset + 50 : 0, cursor.revision);
        }
        if (run && owner) await app.finishKnowledgeReview({ personalSpaceId: space, reviewId: run.review_id, disposition: 'completed' });
      }
      finally { store.release(space, project, token); }
    }
  }
  async function reviewAcrossScopes(service, input, automatic = false) {
    const space = input.personalSpaceId, store = service.store();
    const key = `review-all:${input.requestId}`, cached = store.setting(space, key).value;
    if (cached) {
      const records = cached.map(id => store.get(space, id));
      return { ...judgmentHumanInteraction(records, space), records, remaining: null };
    }
    const projects = await app.listPersonalProjects({ personalSpaceId: space });
    const scopes = [null, ...projects.filter(p => p.profile?.lifecycle !== 'archived').map(p => p.project_id)];
    const cursor = store.setting(space, 'review-cursor');
    let records = [], checked = 0;
    for (; checked < Math.min(scopes.length, 25); checked++) {
      const projectId = scopes[((cursor.value ?? 0) + checked) % scopes.length];
      if (automatic && store.policy(space, projectId ?? '').mode === 'manual') continue;
      try {
        const result = await review(service, { ...input, personalProjectId: projectId,
          requestId: `${input.requestId}:${projectId ?? 'global'}`.slice(0, 256) }, { localOnly: true });
        records = result.records;
        if (records.length) { checked++; break; }
      } catch (error) { if (![403, 404, 409].includes(error.status)) throw error; }
    }
    try { store.writeSetting(space, 'review-cursor', ((cursor.value ?? 0) + checked) % scopes.length, cursor.revision); }
    catch (error) { if (error.status !== 409) throw error; }
    store.writeSetting(space, key, records.map(r => r.id), 0);
    return { ...judgmentHumanInteraction(records, space), records, remaining: null, scopesChecked: checked };
  }
  return { review, reviewAutomatic: async (service, raw) => {
    const input = parse(reviewInput, raw); await service.scope(input);
    return reviewAcrossScopes(service, input, true);
  }, assess: (service, input) => assessRouting({ app, decide, context, service, input }),
  accept: (service, input) => assessAcceptance({ app, decide, context, service, input }),
  // A session answered a handed-off judgment: rerun the same operation, which
  // uses that answer only while its evidence and policy are unchanged.
  // execution names the role_work execution that may use the answer.
  resume(service, { operation, input, session, execution }) {
    const executing = call => decide({ ...call, execution });
    if (operation === TONBORG_OPERATIONS.review) return review(service, input, { localOnly: true, execution });
    if (operation === TONBORG_OPERATIONS.routing) return assessRouting({ app, decide: executing, context, service, input });
    if (operation === TONBORG_OPERATIONS.acceptance) {
      return assessAcceptance({ app, decide: executing, context, service, input: { ...input, taskContextToken: session.taskContextToken } });
    }
    throw new TypeError(`Unknown Tonborg operation: ${operation}`);
  } };
}

function reviewDecisions(value, schema, candidates) {
  const { decisions } = parse(jsonSchemaToZod(schema), value);
  if (decisions.length !== candidates.length || new Set(decisions.map(d => d.target)).size !== candidates.length
    || decisions.some(d => !candidates.some(c => c.candidate_key === d.target))) throw new TypeError('Judgment targets do not match evidence');
  return decisions;
}

// The build that answered, as the review gate keys it: the model and its
// served digest, the prompt and context versions, and the sampling. A model
// receipt names a digest only when its backend reports one; without it no
// entry matches. A current-session answer names no model.
function reviewGateKey(answer) {
  return { modelId: answer.model ?? null, modelDigest: answer.modelReceipt?.modelDigest ?? null,
    promptVersion: REVIEW_PROMPT_VERSION, contextVersion: PREFERENCE_RECEIPT_VERSION, sampling: REVIEW_SAMPLING };
}

// rec#10 D-24: what the host does with one review verdict. The model's own
// outcome is kept as it answered; each reason the host stopped an approval
// from applying is listed beside it. Only an approval with no such reason is
// applied as ai_reviewed; anything else is ai_suggested, which the person
// decides. A manual policy keeps the approval as the outcome it shows but
// still applies nothing.
function reviewDisposition(decision, { protectedItem, gate, policy }) {
  const interceptions = decision.outcome !== 'approve' ? [] : [
    ...(protectedItem ? ['needs_attention'] : []),
    ...(decision.confidence < REVIEW_CONFIDENCE_FLOOR ? ['below_confidence'] : []),
    ...(gate.status !== 'passed' ? ['gate_not_passed'] : []),
    ...(policy.mode === 'manual' ? ['manual_policy'] : [])];
  const applies = decision.outcome === 'approve' && !interceptions.length;
  return { state: applies ? 'ai_reviewed' : 'ai_suggested', modelOutcome: decision.outcome, interceptions, gate };
}
