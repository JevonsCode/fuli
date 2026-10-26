import { randomBytes } from 'node:crypto';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { createActivation } from './activation.js';
import { approvalTerms } from './authorization.js';
import { decisionSource, TERMINAL_CONFIRMATION } from './decision-source.js';
import { appConflict } from './errors.js';
import { CONFIRMATION_NOTICE, TERMS_VERSION, TRUST_MODE, TRUST_WARNING } from './trust-terms.js';

// A challenge is answered within this window, once.
const CHALLENGE_WINDOW_MS = 10 * 60_000;
const NONCE_BYTES = 32;
const CHALLENGE_ID_BYTES = 16;
const CLAIM_BYTES = 16;
const EVENT_DETAIL = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// What a decision binds when no Windows Hello is added.
const NO_PRESENCE = 'none';

const NOT_APPROVED = 'Nothing was approved or activated, and the app does not run (未批准、未激活，应用不运行).';
const PRESENCE_MESSAGES = Object.freeze({
  presence_canceled: 'Windows Hello was canceled.',
  presence_failed: 'Windows Hello did not verify the user.',
  presence_unavailable: 'Windows Hello is unavailable here'
});

// `fuli app approve` and `fuli app rollback`: the terminal confirmation flow
// (rec#11 D-36.1, D-36.9). The CLI shows the app name, a short summary of this
// version's terms and the trusted-mode warning, and the user types the app
// name back. That completes the terminal confirmation flow; it does not prove
// a person did it and does not protect against other programs running as the
// same account. With `--hello` on Windows, Windows Hello is asked as well and
// its result is recorded as presence hello; it is never required.
//
// A challenge carries a 10-minute nonce that only this process holds and the
// digest of everything the decision covers: the exact action, the full
// approval terms with the package digest (approvalBinds), the trust mode and
// terms version (trust-terms.js), the app state it starts from and the
// confirmations given. The nonce is consumed once, by one claim that is
// committed before anything else, and only that claim can then commit the
// decision, after the terms are computed again. A cancellation, a wrong name,
// a failed Hello that was asked for, expiry, changed terms or a failed commit
// leaves the challenge consumed and approves nothing: no approval, no change
// of the active version, no earlier approval restored.
// Only the CLI composes this module; the console and Agent tools cannot reach it.
//
// confirmation.ask({ challengeId, message, appName }) shows message and
// returns the line typed, or null when the user cancelled. presence: the
// optional Windows Hello port (src/presence/port.js), or null.
export function createConfirmedDecisions(context, { confirmation, presence = null }) {
  const { store, now } = context;
  const activation = createActivation(context);

  const prepare = (decision) => (decision.action === 'approve'
    ? activation.approvable(decision) : activation.reactivatable(decision));

  function termsDigest(decision, { app, version }) {
    return contentHash({ decision, status: app.status, activeVersion: app.activeVersion, dataFormat: app.dataFormat,
      versionState: version.state, terms: approvalTerms(version) });
  }

  // lease: the app's owner lease decide() holds; every transaction checks its fence.
  const transaction = (lease, work) => store.transaction(() => {
    if (lease) context.leases.assertOwned(lease);
    return work();
  });

  // Refuses before anything is asked when the decision could not be committed
  // now, including a resident service or data migration not yet confirmed.
  // The decision binds the trust mode and terms version of this FULI and
  // whether Windows Hello is part of it.
  function issueChallenge(request, lease = null) {
    const decision = { ...request, trustMode: TRUST_MODE, termsVersion: TERMS_VERSION,
      presence: presence ? presence.kind : NO_PRESENCE };
    return transaction(lease, () => {
      const prepared = prepare(decision);
      const nonce = randomBytes(NONCE_BYTES).toString('base64url');
      const challengeId = `apc-${randomBytes(CHALLENGE_ID_BYTES).toString('hex')}`;
      const expiresAt = new Date(context.clock().getTime() + CHALLENGE_WINDOW_MS).toISOString();
      store.saveChallenge(decision.appId, { challengeId, nonceHash: contentHash(nonce), decision,
        terms: termsDigest(decision, prepared), expiresAt });
      store.recordEvent({ appId: decision.appId, at: now(), action: 'challenge_issued', version: decision.version,
        detail: { challengeId, decision: decision.action, expiresAt } });
      const summary = termsSummary(decision, prepared, challengeId);
      return { appId: decision.appId, challengeId, nonce, expiresAt, appName: prepared.app.name,
        message: [...summary, TRUST_WARNING.zh, TRUST_WARNING.en, CONFIRMATION_NOTICE.zh, CONFIRMATION_NOTICE.en].join('\n'),
        helloMessage: summary.join('\n') };
    });
  }

  // outcome: { typed, presence } — the line typed for this challenge and, when
  // Windows Hello is part of the decision, what it reported. The commit runs in
  // two steps, and the first is what makes it one-time:
  // 1. claim: one committed transaction consumes the challenge and stores a
  //    claim token only this call holds. Of concurrent commits exactly one
  //    claims it; every other one, then or later, is challenge_replayed.
  // 2. finalize: one transaction checks the answer and the terms again and
  //    either approves (or activates) and releases the claim, or records the
  //    refusal and releases it. Only the claim holder can finalize.
  // When finalizing throws (a storage error), it rolls back whole, so nothing
  // is approved, and a further transaction records the failure. The challenge
  // was consumed in step 1 and stays consumed: a failed attempt is never
  // offered to another submitter. A crash between the steps leaves it
  // consumed and unapproved.
  function commitChallenge(challenge, outcome, actor, lease = null) {
    const claimed = transaction(lease, () => claimChallenge(challenge));
    if (claimed.refusal) throw claimed.refusal;
    let settled;
    try {
      settled = transaction(lease, () => finalize(claimed, outcome, actor));
    } catch (error) {
      try {
        transaction(lease, () => finalizeFailed(claimed, actor, error));
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'The decision failed, and so did recording it; its challenge stays consumed');
      }
      throw error;
    }
    if (settled.refusal) throw settled.refusal;
    return settled.result;
  }

  function claimChallenge({ appId, challengeId, nonce }) {
    const open = store.challenge(appId);
    if (!open || open.challengeId !== challengeId || open.nonceHash !== contentHash(String(nonce))) {
      return { refusal: appConflict('challenge_mismatch', 'This is not the open challenge of this app; start the decision again') };
    }
    const claim = randomBytes(CLAIM_BYTES).toString('base64url');
    const at = now();
    if (!store.claimChallenge(appId, challengeId, { at, claim })) {
      return { refusal: appConflict('challenge_replayed', 'This challenge was already used; start the decision again') };
    }
    return { open, claim, at };
  }

  function finalize({ open, claim, at }, outcome, actor) {
    const { challengeId, decision } = open;
    if (!store.releaseChallengeClaim(decision.appId, challengeId, claim)) {
      return { refusal: appConflict('challenge_mismatch', 'Another decision replaced this challenge; start the decision again') };
    }
    const checked = checkedDecision(open, outcome);
    if (checked.refusal) {
      recordConsumed(open, { at, actor, outcome: checked.refusal.code, detail: outcome?.presence?.detail });
      return checked;
    }
    recordConsumed(open, { at, actor, outcome: 'confirmed' });
    const check = { presence: decision.presence === NO_PRESENCE ? 'unverified' : decision.presence,
      verification: TERMINAL_CONFIRMATION, challengeId, verifiedAt: at, trustMode: decision.trustMode,
      termsVersion: decision.termsVersion };
    const { verifiedAt: _at, ...recorded } = check;
    const record = { at, actor: actor.user, check, detail: { entrypoint: 'cli', ...recorded } };
    const result = decision.action === 'approve'
      ? activation.approve(checked.prepared, record) : activation.reactivate(checked.prepared, record);
    return { result: { ...result, approval: { entrypoint: 'cli', ...check } } };
  }

  function finalizeFailed({ open, claim, at }, actor, error) {
    if (store.releaseChallengeClaim(open.decision.appId, open.challengeId, claim)) {
      recordConsumed(open, { at, actor, outcome: 'decision_failed', detail: error?.code });
    }
  }

  // detail: a short code from the presence port or the failed operation, never a path, a message or the line typed.
  function recordConsumed({ challengeId, decision }, { at, actor, outcome, detail }) {
    const code = typeof detail === 'string' && EVENT_DETAIL.test(detail) ? { detail } : {};
    store.recordEvent({ appId: decision.appId, at, action: 'challenge_consumed', version: decision.version,
      actor: actor?.user ?? null, detail: { challengeId, decision: decision.action, outcome, ...code } });
  }

  // Runs after the challenge is consumed: any refusal here commits with it.
  function checkedDecision(open, outcome) {
    const { decision } = open;
    if (Date.parse(open.expiresAt) <= context.clock().getTime()) {
      return { refusal: appConflict('challenge_expired', `The challenge expired after 10 minutes. ${NOT_APPROVED}`) };
    }
    const typed = typeof outcome?.typed === 'string' ? outcome.typed.trim() : '';
    if (!typed) return { refusal: appConflict('confirmation_canceled', `The confirmation was cancelled. ${NOT_APPROVED}`) };
    if (typed !== store.existingApp(decision.appId).name) {
      return { refusal: appConflict('confirmation_mismatch', `The name typed is not this app's name. ${NOT_APPROVED}`) };
    }
    if (decision.presence !== NO_PRESENCE && outcome.presence?.verified !== true) {
      return { refusal: presenceRefusal(outcome.presence) };
    }
    if (decision.trustMode !== TRUST_MODE || decision.termsVersion !== TERMS_VERSION) {
      return { refusal: appConflict('challenge_mismatch',
        `The challenge was issued under other approval terms, so it does not cover these. ${NOT_APPROVED}`) };
    }
    let prepared;
    try {
      prepared = prepare(decision);
    } catch (error) {
      if (error instanceof ApplicationError) return { refusal: error };
      throw error;
    }
    if (termsDigest(decision, prepared) !== open.terms) {
      return { refusal: appConflict('challenge_mismatch',
        `The app or its terms changed after the confirmation, so it does not cover them. ${NOT_APPROVED}`) };
    }
    return { prepared };
  }

  // The line typed and, only when it names this app, the optional Hello result.
  async function answer(challenge) {
    let typed;
    try {
      typed = await confirmation.ask({ challengeId: challenge.challengeId, message: challenge.message,
        appName: challenge.appName });
    } catch {
      // A prompt that failed to answer is a cancelled one; the challenge is consumed all the same.
      typed = null;
    }
    if (!presence || typeof typed !== 'string' || typed.trim() !== challenge.appName) return { typed };
    try {
      return { typed, presence: await presence.verify({ challengeId: challenge.challengeId, message: challenge.helloMessage }) };
    } catch {
      return { typed, presence: { verified: false, reason: 'presence_unavailable', detail: 'presence_check_failed' } };
    }
  }

  async function decide(decision, actor) {
    if (decisionSource(actor).entrypoint !== 'cli') throw new TypeError('A terminal-confirmed decision comes through the CLI');
    // The whole decision, confirmation included, is one app operation
    // (operations.js): refused before any prompt while another FULI process
    // holds the app, and nothing else of this process changes it meanwhile.
    return context.operations.run(decision.appId, decision.action, async (lease) => {
      const challenge = issueChallenge(decision, lease);
      return commitChallenge(challenge, await answer(challenge), actor, lease);
    });
  }

  return {
    approve: ({ appId, version, digest, approver, confirmResident = false, confirmIrreversibleMigration = false }) =>
      decide({ action: 'approve', appId, version, digest, confirmResident, confirmIrreversibleMigration }, approver),
    rollback: ({ appId, version, actor, confirmIrreversibleMigration = false }) =>
      decide({ action: 'rollback', appId, version, confirmIrreversibleMigration }, actor),
    // The two halves of a decision, around the confirmation.
    issueChallenge, commitChallenge
  };
}

function presenceRefusal(outcome) {
  const reason = Object.hasOwn(PRESENCE_MESSAGES, outcome?.reason) ? outcome.reason : 'presence_unavailable';
  const cause = reason === 'presence_unavailable' ? ` (${outcome?.detail ?? 'no answer'}).` : '';
  return appConflict(reason, `${PRESENCE_MESSAGES[reason]}${cause} ${NOT_APPROVED}`);
}

// The short summary of what is decided: the app, the exact package and what it may do.
function termsSummary(decision, { app, version }, challengeId) {
  const { manifest } = version;
  const data = manifest.data.scope === 'app' ? `own data directory, format ${manifest.data.format}` : 'none';
  return [
    decision.action === 'approve' ? `FULI: approve Agent app ${app.name} ${version.version}`
      : `FULI: activate approved version ${version.version} of Agent app ${app.name}`,
    `${manifest.title} — by Agent ${app.agentId}`,
    `App ${app.appId}`,
    `Digest ${version.digest}`,
    `Permissions ${manifest.permissions.join(', ') || 'none'}`,
    `Data ${data}`,
    `Resident service ${manifest.resident ? 'yes' : 'no'}`,
    `Challenge ${challengeId}`
  ];
}
