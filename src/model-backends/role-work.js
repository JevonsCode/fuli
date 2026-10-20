import { randomUUID } from 'node:crypto';

import { ApplicationError } from '../app/application-error.js';
import { decisionContract, decisionEnvelope } from './decision-contract.js';
import { parseDecisionRequest, parseRoleWorkClaim, parseRoleWorkSubmission } from './request.js';

// D-04 §2 session bridge, the same for every built-in Agent role. A role asks
// for a decision; its configured model answers through the port, or, when
// the role has no model or its model failed in a fallback-eligible way, the
// work becomes a bounded package for the current active session. The session
// claims it under a lease and submits an answer; the host checks it against
// the same contract as a model answer and then reruns the role's own
// operation, so permission gates and execution receipts are the role's as
// always. A package is not a fallback that happened: nothing has run until a
// session answers. Refusals, privacy and permission stops and exhausted
// budgets never become packages, and this module never starts a CLI, a
// session or another model.

const LEASE_MS = 10 * 60_000;
const PACKAGE_TTL_MS = 72 * 60 * 60_000;
// One repair, like a model answer that failed validation once.
const MAX_INVALID_SUBMISSIONS = 2;
const GUIDANCE = 'Not run yet. The current session may complete it with role_work claim, then submit. '
  + 'A session answer is its own assessment, never an independent verification.';

export function createRoleWorkBridge({ port, store, verifySession, resumers, now = () => new Date() }) {
  async function decide(input, { resume = null } = {}) {
    const request = parseDecisionRequest(input);
    const at = now();
    const submitted = store.submitted(request.role, request.requestId);
    if (submitted) {
      if (sameWork(submitted, request)) {
        const used = store.transition(submitted.packageId, ['submitted'], { status: 'completed' }, { name: 'completed' }, at);
        if (used) return sessionAnswer(used);
      } else {
        store.transition(submitted.packageId, ['submitted'], { status: 'stale' }, { name: 'stale', detail: { reason: 'evidence_or_policy_changed' } }, at);
      }
    }
    const open = store.open(request, at);
    if (open) return pending(open, null);
    const { envelope, modelReceipt } = await port.decide(request);
    if (modelReceipt.status === 'completed') return { status: 'answered', mode: 'model_api', independent: true, envelope, modelReceipt };
    if (modelReceipt.status === 'not_configured' || modelReceipt.fallbackEligible) {
      const created = store.create({ request, resume, reason: modelReceipt.fallbackReason ?? modelReceipt.reason,
        fallbackReceipt: modelReceipt.status === 'not_configured' ? null : modelReceipt, at, ttlMs: PACKAGE_TTL_MS });
      return pending(created, modelReceipt);
    }
    return { status: modelReceipt.status, modelReceipt };
  }

  async function claim(raw) {
    const input = parseRoleWorkClaim(raw);
    const session = await verifySession(input);
    const at = now();
    store.expire(at);
    const found = input.packageId ? existing(input.packageId) : store.nextClaimable(session, at);
    if (!found) return { workPackage: null };
    assertHolder(found, session);
    const claimed = store.claim(found.packageId, session,
      { leaseToken: randomUUID(), leaseExpiresAt: new Date(at.getTime() + LEASE_MS), at });
    if (claimed.conflict === 'busy') throw new ApplicationError('role_work_busy', 'Another session holds this work package.', { status: 409 });
    if (claimed.conflict) throw new ApplicationError('role_work_closed', `This work package is ${found.status}.`, { status: 409 });
    return { workPackage: claimView(claimed.workPackage) };
  }

  async function submit(raw) {
    const input = parseRoleWorkSubmission(raw);
    const session = await verifySession(input);
    const at = now();
    const work = existing(input.packageId);
    assertHolder(work, session);
    if (work.lease?.token !== input.leaseToken || work.lease.sessionRef !== session.sessionRef) return stale(work, 'lease_mismatch', at);
    // C9: the lease token is the submission's idempotency key. A retry after
    // a lost reply returns the recorded result and changes nothing.
    if (work.status === 'completed') return { status: 'completed', replayed: true, result: work.result };
    if (work.status === 'submitted') return resumeRole(work, session, at);
    if (work.status !== 'claimed') return stale(work, `package_${work.status}`, at);
    if (Date.parse(work.expiresAt) <= at.getTime()) return stale(work, 'package_expired', at);
    if (Date.parse(work.lease.expiresAt) <= at.getTime()) return stale(work, 'lease_expired', at);

    const verdict = decisionContract(work.request).validateReply(JSON.stringify(input.answer));
    const attemptNumber = work.invalidSubmissions + 1;
    port.recordSessionAttempt({ request: work.request, attemptId: `${work.lease.token}:${attemptNumber}`, attemptNumber,
      startedAt: work.lease.claimedAt, durationMs: at.getTime() - Date.parse(work.lease.claimedAt),
      outcome: verdict.ok ? 'succeeded' : 'invalid_output', usage: input.usage ?? null });
    if (!verdict.ok) {
      const failed = attemptNumber >= MAX_INVALID_SUBMISSIONS;
      store.transition(work.packageId, ['claimed'], { status: failed ? 'failed' : 'claimed', invalidSubmissions: attemptNumber },
        { name: 'invalid_submission', detail: { issues: verdict.issues } }, at);
      return { status: failed ? 'failed' : 'invalid', issues: verdict.issues, repairsLeft: MAX_INVALID_SUBMISSIONS - attemptNumber };
    }
    const submission = { envelope: decisionEnvelope(work.request, verdict.value), submittedAt: at.toISOString(),
      session: { sessionRef: session.sessionRef, sourceApplication: session.sourceApplication } };
    const accepted = store.transition(work.packageId, ['claimed'], { status: 'submitted', submission }, { name: 'submitted' }, at);
    return accepted ? resumeRole(accepted, session, at) : stale(work, 'lease_mismatch', at);
  }

  // The role reruns its operation with fresh evidence; its decide() call
  // uses the submitted answer only while the evidence and policy versions
  // still match.
  async function resumeRole(work, session, at) {
    const resume = resumers[work.role];
    if (!resume || !work.resume) throw new ApplicationError('role_work_unresumable', `No ${work.role} operation can use this answer.`, { status: 409 });
    let result;
    try {
      result = await resume({ operation: work.operation, input: work.resume, session });
    } catch (error) {
      if (error.status === 409) store.transition(work.packageId, ['submitted'], { status: 'stale' }, { name: 'stale', detail: { reason: error.code ?? 'conflict' } }, at);
      throw error;
    }
    const after = store.get(work.packageId);
    if (after.status === 'completed') {
      store.transition(work.packageId, ['completed'], { result }, { name: 'result_recorded' }, at);
      return { status: 'completed', result };
    }
    store.transition(work.packageId, ['submitted'], { status: 'stale' }, { name: 'stale', detail: { reason: 'not_used' } }, at);
    return { status: 'stale', reason: 'evidence_or_policy_changed', result };
  }

  function existing(packageId) {
    const work = store.get(packageId);
    if (!work) throw new ApplicationError('not_found', 'Work package not found.', { status: 404 });
    return work;
  }

  function stale(work, reason, at) {
    store.recordStale(work.packageId, reason, at);
    return { status: 'stale', reason, workPackage: summary(store.get(work.packageId)) };
  }

  return { decide, claim, submit, summary: () => ({ packages: store.counts() }), close: () => store.close() };
}

// A package bound to a session is that session's alone. An unbound package
// belongs to its project: a newer session is checked against the scope again
// and does not inherit an earlier session's authority.
function assertHolder(work, session) {
  const allowed = work.scope.personalSpaceId === session.personalSpaceId && (work.scope.sessionRef
    ? work.scope.sessionRef === session.sessionRef
    : work.scope.personalProjectId === null || work.scope.personalProjectId === session.personalProjectId);
  if (!allowed) throw new ApplicationError('role_work_scope_mismatch', 'This work package belongs to another session or project.', { status: 403 });
}

function sameWork(work, request) {
  return work.operation === request.operation && work.scope.personalProjectId === request.scope.personalProjectId
    && work.versions.evidence === request.versions.evidence && work.versions.policy === request.versions.policy;
}

function sessionAnswer(work) {
  return { status: 'answered', mode: 'current_session', independent: false, envelope: work.submission.envelope,
    session: work.submission.session, workPackageId: work.packageId, modelReceipt: work.fallbackReceipt };
}

function pending(work, modelReceipt) {
  return { status: 'pending', workPackage: summary(work), modelReceipt };
}

function summary(work) {
  return { packageId: work.packageId, role: work.role, operation: work.operation, requestId: work.requestId,
    status: work.status, reason: work.reason, sessionRef: work.scope.sessionRef, expiresAt: work.expiresAt, guidance: GUIDANCE };
}

// What the session needs to answer, and no more: the bounded instructions,
// the evidence, the exact answer schema and the lease.
function claimView(work) {
  const { request } = work;
  return { ...summary(work), scope: work.scope, versions: work.versions, instructions: request.instructions,
    evidence: request.evidence.map(({ id: evidenceId, text }) => ({ id: evidenceId, text })),
    answerSchema: decisionContract(request).providerSchema, budget: request.budget,
    lease: { token: work.lease.token, expiresAt: work.lease.expiresAt } };
}
