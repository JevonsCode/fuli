import { setTimeout as delay } from 'node:timers/promises';

import { certificateFingerprint, verifyDeviceSignature } from './device-identity.js';
import { isAuthorityKey, verifyOriginProof } from './origin-proof.js';
import { PEER_LIMITS, PeerError, validateAssertion } from './protocol.js';

const RETRY_MS = 5_000;
const STARTED_STATES = new Set(['starting', 'running', 'finished']);

// Receives asks for this device's shared project leads. Every claim is written
// down before it is accepted, nothing runs before the coordinator confirmed the
// acceptance, and an attempt that may have run is never reported as not started.
export function createPeerRunner({ store, client, roundtable, provider, nodeId, spaceId,
  clock = Date.now, retryMs = RETRY_MS, renewMs = PEER_LIMITS.renewSeconds * 1000, onError = () => {} }) {
  const stopping = new AbortController();
  const running = new Map();
  const handlers = new Map();
  let loop = null;

  function start() {
    loop ??= run();
    return loop;
  }

  async function run() {
    recover();
    while (!stopping.signal.aborted) {
      await flush();
      let claim = null;
      try {
        claim = (await client.post('/peer/1/claim', {}, { signal: stopping.signal,
          timeoutMs: PEER_LIMITS.claimWaitMs + 10_000 })).claim;
      } catch (error) {
        if (stopping.signal.aborted) break;
        onError(error);
        await pause(retryMs);
        continue;
      }
      if (claim) handle(claim).catch(onError);
    }
  }

  // After a restart nothing from a previous run is still being supervised.
  function recover() {
    for (const attempt of store.unfinishedAttempts()) {
      const started = STARTED_STATES.has(attempt.state);
      queue(attempt.message_id, attempt.attempt_id, started ? 'unknown' : 'never_started',
        { error: started ? 'runner_restarted' : 'not_started' });
    }
  }

  // Tracked so stop() can wait for every handler before the store is closed.
  function handle(claim) {
    const work = handleClaim(claim);
    handlers.set(work, claim.messageId);
    return work.finally(() => handlers.delete(work));
  }

  async function handleClaim(claim) {
    const { messageId, attemptId } = claim;
    // Not accepted: the coordinator hands the claim out again after its short window.
    if (stopping.signal.aborted) return;
    if (!store.recordAttempt({ messageId, attemptId, bindingId: claim.assertion?.to?.bindingId }).inserted) return;
    let acceptance;
    const acceptedAt = clock();
    try {
      acceptance = await client.post('/peer/1/renew', { messageId, attemptId, state: 'accepted' }, { signal: stopping.signal });
      if (stopping.signal.aborted) throw new PeerError('stopped', 'The runner stopped while accepting', 499);
    } catch (error) {
      // The acceptance may or may not have been recorded; the coordinator decides
      // between requeueing and unknown. Nothing was started here either way.
      store.setAttemptState(messageId, attemptId, 'not_started', error.code ?? 'accept_failed');
      queue(messageId, attemptId, 'never_started', { error: error.code ?? 'accept_failed' });
      return flush();
    }
    store.setAttemptState(messageId, attemptId, 'accepted');
    if (acceptance?.cancel) {
      store.setAttemptState(messageId, attemptId, 'not_started', 'cancelled');
      queue(messageId, attemptId, 'cancelled', { error: 'cancelled' });
      return flush();
    }
    let authorized;
    try {
      authorized = authorize(claim);
    } catch (error) {
      store.setAttemptState(messageId, attemptId, 'rejected', error.code ?? 'rejected');
      queue(messageId, attemptId, 'failed', { error: error.code ?? 'rejected' });
      return flush();
    }
    if (stopping.signal.aborted) {
      store.setAttemptState(messageId, attemptId, 'not_started', 'stopped');
      queue(messageId, attemptId, 'never_started', { error: 'stopped' });
      return flush();
    }
    store.setAttemptState(messageId, attemptId, 'starting');
    const outcome = await supervise(claim, authorized, acceptedAt);
    store.setAttemptState(messageId, attemptId, 'finished', outcome.outcome);
    queue(messageId, attemptId, outcome.outcome, outcome);
    return flush();
  }

  // Every check that decides whether this device may act, before any authority is issued.
  function authorize(claim) {
    const { assertion, signature, sender } = claim;
    validateAssertion(assertion, { now: clock() });
    if (!sender || certificateFingerprint(sender.certPem) !== sender.nodeId || assertion.from.node !== sender.nodeId) {
      throw new PeerError('sender_mismatch', 'The message sender does not match its device', 403);
    }
    if (!verifyDeviceSignature(sender.certPem, assertion, signature)) throw new PeerError('invalid_signature', 'Invalid device signature', 403);
    if (assertion.to.node !== nodeId) throw new PeerError('wrong_device', 'The message is for another device', 403);
    const share = store.share(assertion.to.bindingId);
    if (!share || share.agentId !== assertion.to.agentId || share.spaceId !== spaceId()) {
      throw new PeerError('agent_not_shared', 'That Agent is not shared on this device', 403);
    }
    const authority = pinnedAuthority(sender);
    const origin = verifyOriginProof(assertion, authority, { now: clock() });
    const earlier = store.attemptsFor(claim.messageId)
      .filter((attempt) => attempt.attempt_id !== claim.attemptId && STARTED_STATES.has(attempt.state));
    if (earlier.length) throw new PeerError('already_started', 'This message already started on this device', 409);
    return { share, origin };
  }

  function pinnedAuthority(sender) {
    const pinned = store.authority(sender.nodeId);
    if (pinned) {
      if (sender.authority && (sender.authority.keyId !== pinned.keyId || sender.authority.publicKey !== pinned.publicKey)) {
        throw new PeerError('authority_changed', 'The sending device presented a different origin key; pair it again', 403);
      }
      return pinned;
    }
    // Devices other than the coordinator are bound on first contact from the
    // coordinator's pairing record, and pinned from then on.
    if (!isAuthorityKey(sender.authority)) throw new PeerError('authority_unknown', 'The sending device has no origin key', 403);
    const { bound, authority } = store.bindAuthority(sender.nodeId, sender.authority, 'coordinator');
    if (!bound) throw new PeerError('authority_changed', 'The sending device presented a different origin key; pair it again', 403);
    return authority;
  }

  async function supervise(claim, { share }, acceptedAt) {
    const { messageId, attemptId } = claim;
    const controller = new AbortController();
    let reason = null;
    const stop = (why) => { reason ??= why; controller.abort(why); };
    const stopOnShutdown = () => stop('stopped');
    stopping.signal.addEventListener('abort', stopOnShutdown, { once: true });
    if (stopping.signal.aborted) stopOnShutdown();
    let lastRenewal = acceptedAt;
    let leaseTimer;
    const armDeadline = () => {
      clearTimeout(leaseTimer);
      if (controller.signal.aborted) return;
      const remaining = PEER_LIMITS.leaseSeconds * 1000 - (clock() - lastRenewal);
      if (remaining <= 0) stop('lease_lost');
      else leaseTimer = setTimeout(() => stop('lease_lost'), remaining);
    };
    armDeadline();
    async function renew(state) {
      const sentAt = clock();
      try {
        const answer = await client.post('/peer/1/renew', { messageId, attemptId, state }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        lastRenewal = Math.max(lastRenewal, sentAt);
        armDeadline();
        if (answer.cancel) stop('cancelled');
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error.status === 403 || error.status === 409) stop(error.status === 403 ? 'cancelled' : 'lease_lost');
      }
    }
    const renewals = (async () => {
      while (!controller.signal.aborted) {
        try { await delay(renewMs, undefined, { signal: controller.signal }); } catch { return; }
        const state = store.attemptsFor(messageId).find((attempt) => attempt.attempt_id === attemptId)?.state;
        await renew(state === 'running' ? 'running' : 'starting');
      }
    })();
    running.set(messageId, { controller, share, stop });
    try {
      const answer = await roundtable.answerRemote({ claim, share, signal: controller.signal,
        timeoutMs: PEER_LIMITS.executionSeconds * 1000,
        onSpawn: () => {
          try { store.setAttemptState(messageId, attemptId, 'running'); }
          catch { stop('persistence_failed'); return; }
          void renew('running');
        },
        issueGrant: (delivery, lifetime) => provider.issueRemoteAgentDelegation({
          personal_space_id: share.spaceId, personal_project_id: share.projectId, agent_id: share.agentId,
          target_application: delivery.client,
          target_session_id: delivery.client === 'codex' ? delivery.sessionId : null,
          lifetime_seconds: Math.max(30, Math.min(900, Math.round(lifetime))),
          origin_node: claim.sender.nodeId, origin_message_id: messageId, origin_attempt_id: attemptId }) });
      if (controller.signal.aborted) throw new PeerError('cancelled', 'The delivery was stopped', 499);
      return { outcome: 'answered', reply: answer.body, via: answer.via, verified: true };
    } catch (error) {
      if (reason === 'lease_lost') return { outcome: 'unknown', error: 'lease_lost' };
      if (reason === 'cancelled' || reason === 'stopped' || error.code === 'cancelled') return { outcome: 'cancelled', error: reason ?? 'cancelled' };
      return { outcome: 'failed', error: error.code ?? 'wake_failed' };
    } finally {
      controller.abort('finished');
      clearTimeout(leaseTimer);
      stopping.signal.removeEventListener('abort', stopOnShutdown);
      running.delete(messageId);
      await renewals;
    }
  }

  function queue(messageId, attemptId, outcome, { reply = null, via = null, verified = false, error = null } = {}) {
    store.queueResult(messageId, attemptId, { messageId, attemptId, outcome, reply, via, verified, error });
  }

  async function flush() {
    for (const pending of store.pendingResults()) {
      try {
        await client.post('/peer/1/result', pending.payload);
        store.markDelivered(pending.messageId, pending.attemptId);
      } catch (error) {
        // The coordinator already moved on from this attempt; keep the local record only.
        if (error.status === 404 || error.status === 409) store.markDelivered(pending.messageId, pending.attemptId);
        else return;
      }
    }
  }

  async function pause(ms) {
    try { await delay(ms, undefined, { signal: stopping.signal }); } catch { /* stopping */ }
  }

  async function stop() {
    stopping.abort();
    for (const { stop } of running.values()) stop('stopped');
    await loop?.catch(() => {});
    await Promise.allSettled([...handlers.keys()]);
    await flush();
  }

  async function reconcileShares(validBindings = null) {
    const cancelled = new Set();
    for (const [messageId, { share, stop }] of running) {
      const current = store.share(share.bindingId);
      if (!current || (validBindings && !validBindings.has(share.bindingId))
        || current.workingDirectory !== share.workingDirectory
        || share.clients.some((client) => !current.clients.includes(client))) {
        cancelled.add(messageId);
        stop('cancelled');
      }
    }
    await Promise.allSettled([...handlers].filter(([, id]) => cancelled.has(id)).map(([work]) => work));
  }

  return { start, stop, flush, handle, reconcileShares, active: () => running.size };
}
