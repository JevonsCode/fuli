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
// One execution holds an answer this long; past it, a retry takes over (the
// process applying it is presumed gone).
const APPLY_MS = 10 * 60_000;
const ANSWERED = Object.freeze(['submitted', 'applying', 'completed']);
const GUIDANCE = 'Not run yet. The current session may complete it with role_work claim, then submit. '
  + 'A session answer is its own assessment, never an independent verification.';
const APPLYING_GUIDANCE = 'The answer was accepted and is being applied once. Submit again later for the result.';

export function createRoleWorkBridge({ port, store, verifySession, resumers, prepareStore = async () => {}, now = () => new Date() }) {
  // execution: the token the bridge handed the role's resumer. Only the
  // execution holding a package may use its answer; an execution that lost
  // it (it was slow and another took over) stops here instead of asking
  // anew, and a call outside any execution never takes an applying answer.
  // inline: the current session asked and already holds the evidence (rec#10
  // D-26.1). No package is created; without a model, or after a
  // fallback-eligible failure, the caller's usual answer for the session
  // stands. Every model attempt was still settled in the ledger by the port.
  async function decide(input, { resume = null, execution = null, inline = false } = {}) {
    const request = parseDecisionRequest(input);
    if (inline) return inlineOutcome(await port.decide(request));
    await prepareStore(request.scope.personalSpaceId);
    const at = now();
    const applying = store.applying(request.role, request.requestId);
    if ((applying || execution) && applying?.execution !== execution) throw executionLost(request);
    // The rerun uses the answer only for the same scope, evidence and policy.
    // Using it is recorded; completion waits for the role's result. An answer
    // already used is never declared stale.
    if (applying) {
      const use = sameWork(applying, request) ? [applying.consumedAt ? {} : { consumedAt: at }, { name: 'consumed' }]
        : !applying.consumedAt ? [{ status: 'stale' }, { name: 'stale', detail: { reason: 'evidence_or_policy_changed' } }] : null;
      const changed = use && store.transitionExecution(applying.packageId, execution, ...use, at);
      if (use && !changed) throw executionLost(request);
      if (changed?.status === 'applying') return sessionAnswer(changed);
    }
    const open = store.open(request, at);
    if (open) return pending(open, null);
    if (store.applyingWork(request, at)) {
      throw Object.assign(new ApplicationError('role_work_busy', 'A session answer to this work is being applied. Try again shortly.', { status: 409 }),
        { retryable: true });
    }
    const { envelope, modelReceipt } = await port.decide(request);
    if (modelReceipt.status === 'completed') return modelAnswer(envelope, modelReceipt);
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
    await prepareStore(session.personalSpaceId);
    const at = now();
    store.expire(at, session.personalSpaceId);
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
    await prepareStore(session.personalSpaceId);
    const at = now();
    const work = existing(input.packageId);
    assertHolder(work, session);
    if (work.lease?.token !== input.leaseToken || work.lease.sessionRef !== session.sessionRef) return stale(work, 'lease_mismatch', at);
    // C9: the lease token is the submission's idempotency key. A retry after
    // a lost reply returns the recorded result and changes nothing; a retry
    // while the answer is being applied waits for that one execution.
    if (ANSWERED.includes(work.status)) return retry(work, session, at);
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
    const accepted = store.startExecution(work.packageId, { submission, at, until: applyingUntil(at) });
    return accepted ? resumeRole(accepted, session) : stale(work, 'lease_mismatch', at);
  }

  // An answered package: start the one execution if none holds it (released
  // for a retry, or its earlier execution window passed after a restart),
  // otherwise report where it stands. completed always carries the result.
  function retry(work, session, at) {
    const started = store.startExecution(work.packageId, { at, until: applyingUntil(at) });
    return started ? resumeRole(started, session) : standing(work.packageId, at);
  }

  function standing(packageId, at) {
    const current = store.get(packageId);
    if (current.status === 'completed') return { status: 'completed', replayed: true, result: current.result };
    // Released for a retry counts as in progress too: the answer is kept.
    if (['applying', 'submitted'].includes(current.status)) return { status: 'applying', workPackage: summary(current), guidance: APPLYING_GUIDANCE };
    return stale(current, `package_${current.status}`, at);
  }

  // The role reruns its operation with fresh evidence under this execution's
  // token; its decide() call uses the submitted answer only while the
  // evidence and policy versions still match. The operation is idempotent per
  // requestId, so a rerun after an interrupted execution resolves from what
  // the role already stored. An execution that lost the package (it was slow
  // and another took over) changes nothing here; only a late event remains.
  async function resumeRole(work, session) {
    const resume = resumers[work.role];
    const { execution } = work;
    let result;
    try {
      if (!resume || !work.resume) throw new ApplicationError('role_work_unresumable', `No ${work.role} operation can use this answer.`, { status: 503 });
      result = await resume({ operation: work.operation, input: work.resume, session, execution });
    } catch (error) {
      // Refused before the answer was used (its task or evidence moved on):
      // stale. Busy, or failed in any other way: the answer waits for a retry.
      const refused = error.status === 409 && !error.retryable && !store.get(work.packageId).consumedAt;
      const released = store.transitionExecution(work.packageId, execution, { status: refused ? 'stale' : 'submitted' },
        { name: refused ? 'stale' : 'released', detail: { reason: error.code ?? 'error' } }, now());
      // A late execution's failure is not the package's: report where it stands.
      if (!released) return standing(work.packageId, now());
      throw error;
    }
    const finished = store.finish(work.packageId, execution, result, now());
    if (finished.execution !== execution) return standing(work.packageId, now());
    if (finished.status === 'completed') return { status: 'completed', result: finished.result };
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

// The same rule as the store's open-package match: one operation, the full
// space/project/session scope and the same evidence and policy versions.
function sameWork(work, request) {
  const { scope } = work;
  return work.operation === request.operation && scope.personalSpaceId === request.scope.personalSpaceId
    && scope.personalProjectId === request.scope.personalProjectId && scope.sessionRef === request.scope.sessionRef
    && work.versions.evidence === request.versions.evidence && work.versions.policy === request.versions.policy;
}

function executionLost(request) {
  return new ApplicationError('role_work_execution_lost', `This execution no longer holds the work for ${request.requestId}.`, { status: 409 });
}

function applyingUntil(at) {
  return new Date(at.getTime() + APPLY_MS);
}

function sessionAnswer(work) {
  return { status: 'answered', mode: 'current_session', independent: false, envelope: work.submission.envelope,
    session: work.submission.session, workPackageId: work.packageId, modelReceipt: work.fallbackReceipt };
}

function modelAnswer(envelope, modelReceipt) {
  return { status: 'answered', mode: 'model_api', independent: true, envelope, modelReceipt };
}

// A stop (refusal, privacy or permission, exhausted budget) keeps its own
// status and reason: the session's answer is the caller's usual one, never a
// way around the stop.
function inlineOutcome({ envelope, modelReceipt }) {
  if (modelReceipt.status === 'completed') return modelAnswer(envelope, modelReceipt);
  if (modelReceipt.status === 'not_configured' || modelReceipt.fallbackEligible) {
    return { status: 'inline', answeredBy: 'current_session', fallbackReason: modelReceipt.fallbackReason ?? modelReceipt.reason, modelReceipt };
  }
  return { status: modelReceipt.status, modelReceipt };
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
