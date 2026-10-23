import { randomBytes } from 'node:crypto';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { createActivation } from './activation.js';
import { approvalTerms } from './authorization.js';
import { decisionSource, OS_USER_VERIFIED } from './decision-source.js';
import { appConflict } from './errors.js';

// A challenge is answered within this window, once.
const CHALLENGE_WINDOW_MS = 10 * 60_000;
const NONCE_BYTES = 32;
const CHALLENGE_ID_BYTES = 16;
const EVENT_DETAIL = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const UNVERIFIED_OUTCOME = 'Recorded as unverified: nothing was approved or activated, and the app does not run '
  + '(取消/失败/不可用一律记 unverified，不运行).';
const PRESENCE_MESSAGES = Object.freeze({
  presence_canceled: 'Windows Hello was canceled.',
  presence_failed: 'Windows Hello did not verify the user.',
  presence_unavailable: 'Windows Hello is unavailable here',
  presence_unsupported_platform: 'This platform has no presence check yet, so apps cannot run (本平台尚无在场证明，应用不能运行).'
});

// `fuli app approve` and `fuli app rollback` with a presence check (rec#7 D-28.8).
// The trusted CLI starts an OS user verification (Windows Hello) and binds that
// one successful result to this decision's challenge; Hello returns the user
// verification result, it does not sign the challenge. The challenge carries a
// 10-minute nonce that only this process holds and the digest of everything
// the decision covers: the full approval terms (approvalBinds), the app state
// it starts from and the confirmations given. Consuming the nonce and
// committing the decision happen in one transaction, after the terms are
// computed again. A cancellation, failure, unavailable check, timeout, expiry
// or changed terms consumes the challenge and approves nothing: no approval,
// no change of the active version, no earlier approval restored.
// Only the CLI composes this module; the console and Agent tools cannot reach it.
export function createVerifiedDecisions(context, { presence }) {
  const { store, now } = context;
  const activation = createActivation(context);

  const prepare = (decision) => (decision.action === 'approve'
    ? activation.approvable(decision) : activation.reactivatable(decision));

  function termsDigest(decision, { app, version }) {
    return contentHash({ decision, status: app.status, activeVersion: app.activeVersion, dataFormat: app.dataFormat,
      versionState: version.state, terms: approvalTerms(version) });
  }

  // Refuses before any presence prompt when the decision could not be committed
  // now, including a resident service or data migration not yet confirmed.
  function issueChallenge(decision) {
    return store.transaction(() => {
      const prepared = prepare(decision);
      const nonce = randomBytes(NONCE_BYTES).toString('base64url');
      const challengeId = `apc-${randomBytes(CHALLENGE_ID_BYTES).toString('hex')}`;
      const expiresAt = new Date(context.clock().getTime() + CHALLENGE_WINDOW_MS).toISOString();
      store.saveChallenge(decision.appId, { challengeId, nonceHash: contentHash(nonce), decision,
        terms: termsDigest(decision, prepared), expiresAt });
      store.recordEvent({ appId: decision.appId, at: now(), action: 'challenge_issued', version: decision.version,
        detail: { challengeId, decision: decision.action, expiresAt } });
      return { appId: decision.appId, challengeId, nonce, expiresAt, message: helloMessage(decision, prepared, challengeId) };
    });
  }

  // outcome: what the presence port reported for this challenge. Consuming
  // the challenge and committing the decision share one transaction, so of
  // concurrent commits exactly one consumes it. When that transaction fails
  // instead (a data directory that cannot be created, a storage error), it
  // rolls back whole and the challenge is consumed on its own as a failure:
  // whatever went wrong after the verification attempt, the same answer is
  // never committed again and nothing else changes.
  function commitChallenge(challenge, outcome, actor) {
    let settled;
    try {
      settled = store.transaction(() => commitInTransaction(challenge, outcome, actor));
    } catch (error) {
      try {
        consumeAfterFailure(challenge, actor, error);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'The decision failed, and so did consuming its challenge');
      }
      throw error;
    }
    if (settled.refusal) throw settled.refusal;
    return settled.result;
  }

  function commitInTransaction({ appId, challengeId, nonce }, outcome, actor) {
    const open = openChallenge({ appId, challengeId, nonce });
    if (!open) {
      return { refusal: appConflict('challenge_mismatch', 'This is not the open challenge of this app; start the decision again') };
    }
    const at = now();
    if (!store.consumeChallenge(appId, challengeId, at)) {
      return { refusal: appConflict('challenge_replayed', 'This challenge was already used; start the decision again') };
    }
    const { decision } = open;
    const checked = checkedDecision(open, outcome);
    if (checked.refusal) {
      recordConsumed(open, { at, actor, outcome: checked.refusal.code, detail: outcome?.detail });
      return checked;
    }
    recordConsumed(open, { at, actor, outcome: 'verified' });
    const check = { presence: presence.kind, verification: OS_USER_VERIFIED, challengeId, verifiedAt: at };
    const record = { at, actor: actor.user, check,
      detail: { entrypoint: 'cli', presence: presence.kind, verification: OS_USER_VERIFIED, challengeId } };
    const result = decision.action === 'approve'
      ? activation.approve(checked.prepared, record) : activation.reactivate(checked.prepared, record);
    return { result: { ...result, approval: { entrypoint: 'cli', ...check } } };
  }

  // In its own transaction, and only if no other commit consumed the challenge first.
  function consumeAfterFailure({ appId, challengeId, nonce }, actor, error) {
    store.transaction(() => {
      const open = openChallenge({ appId, challengeId, nonce });
      const at = now();
      if (open && store.consumeChallenge(appId, challengeId, at)) {
        recordConsumed(open, { at, actor, outcome: 'decision_failed', detail: error?.code });
      }
    });
  }

  function openChallenge({ appId, challengeId, nonce }) {
    const open = store.challenge(appId);
    return open && open.challengeId === challengeId && open.nonceHash === contentHash(String(nonce)) ? open : null;
  }

  // detail: a short code from the presence port or the failed operation, never a path or message.
  function recordConsumed({ challengeId, decision }, { at, actor, outcome, detail }) {
    const code = typeof detail === 'string' && EVENT_DETAIL.test(detail) ? { detail } : {};
    store.recordEvent({ appId: decision.appId, at, action: 'challenge_consumed', version: decision.version,
      actor: actor?.user ?? null, detail: { challengeId, decision: decision.action, outcome, ...code } });
  }

  // Runs after the challenge is consumed: any refusal here commits with it.
  function checkedDecision(open, outcome) {
    if (Date.parse(open.expiresAt) <= context.clock().getTime()) {
      return { refusal: appConflict('challenge_expired', `The challenge expired after 10 minutes. ${UNVERIFIED_OUTCOME}`) };
    }
    if (outcome?.verified !== true) return { refusal: presenceRefusal(outcome) };
    let prepared;
    try {
      prepared = prepare(open.decision);
    } catch (error) {
      if (error instanceof ApplicationError) return { refusal: error };
      throw error;
    }
    if (termsDigest(open.decision, prepared) !== open.terms) {
      return { refusal: appConflict('challenge_mismatch',
        `The app or its terms changed after the verification, so it does not cover them. ${UNVERIFIED_OUTCOME}`) };
    }
    return { prepared };
  }

  async function decide(decision, actor) {
    if (decisionSource(actor).entrypoint !== 'cli') throw new TypeError('A presence-checked decision comes through the CLI');
    const challenge = issueChallenge(decision);
    let outcome;
    try {
      outcome = await presence.verify({ challengeId: challenge.challengeId, message: challenge.message });
    } catch {
      // A check that failed to answer is an unavailable one; the challenge is consumed all the same.
      outcome = { verified: false, reason: 'presence_unavailable', detail: 'presence_check_failed' };
    }
    return commitChallenge(challenge, outcome, actor);
  }

  return {
    approve: ({ appId, version, digest, approver, confirmResident = false, confirmIrreversibleMigration = false }) =>
      decide({ action: 'approve', appId, version, digest, confirmResident, confirmIrreversibleMigration }, approver),
    rollback: ({ appId, version, actor, confirmIrreversibleMigration = false }) =>
      decide({ action: 'rollback', appId, version, confirmIrreversibleMigration }, actor),
    // The two halves of a decision, around the presence check.
    issueChallenge, commitChallenge
  };
}

function presenceRefusal(outcome) {
  const reason = Object.hasOwn(PRESENCE_MESSAGES, outcome?.reason) ? outcome.reason : 'presence_unavailable';
  const cause = reason === 'presence_unavailable' ? ` (${outcome?.detail ?? 'no answer'}).` : '';
  return appConflict(reason, `${PRESENCE_MESSAGES[reason]}${cause} ${UNVERIFIED_OUTCOME}`);
}

// What the Hello dialog shows: the decision, the exact package and what it may do.
function helloMessage(decision, { app, version }, challengeId) {
  const { manifest } = version;
  const data = manifest.data.scope === 'app' ? `own data directory, format ${manifest.data.format}` : 'none';
  return [
    decision.action === 'approve' ? `FULI: approve Agent app ${app.name} ${version.version}`
      : `FULI: activate approved version ${version.version} of Agent app ${app.name}`,
    `App ${app.appId}`,
    `Digest ${version.digest}`,
    `Permissions ${manifest.permissions.join(', ') || 'none'}`,
    `Data ${data}`,
    `Resident service ${manifest.resident ? 'yes' : 'no'}`,
    `Challenge ${challengeId}`
  ].join('\n');
}
