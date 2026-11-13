import { setTimeout as delay } from 'node:timers/promises';

import { certificateFingerprint, verifyDeviceSignature } from './device-identity.js';
import { isAuthorityKey, verifyOriginProof } from './origin-proof.js';
import {
  PEER_LIMITS, PEER_QUERY_PROTOCOL, PeerError, peerCleanup, peerMessageKey, validateAssertion, validateQuery,
} from './protocol.js';
import { answerPeerQuery, QUERY_REFUSED, queryCode, requesterLabel } from './query-answer.js';

const RETRY_MS = 5_000;
// A query lives at most a minute and its proof expires with it; past that the
// assertion is refused as expired before its device is proven, never recorded.
const REFUSAL_SKEW_MS = 60_000;
const REFUSALS_REMEMBERED = 2_000;
const STARTED_STATES = new Set(['starting', 'running', 'finished']);
// How each kind of claim is checked: a message may wake the shared lead under
// an execution proof; a query only reads, under a query proof.
const MESSAGE = Object.freeze({ validate: validateAssertion, purpose: 'execution', visitor: false });
const QUERY = Object.freeze({ validate: validateQuery, purpose: 'query', visitor: true });

// Receives asks for this device's shared project leads. Every claim is written
// down before it is accepted, nothing runs before the coordinator confirmed the
// acceptance, and an attempt that may have run is never reported as not started.
// pairedDevices(): on the coordinating computer, the fingerprints of its own
// active paired devices; null on a member, which cannot know the group.
export function createPeerRunner({ store, client, roundtable, host, nodeId, spaceId, pairedDevices = () => null,
  clock = Date.now, retryMs = RETRY_MS, renewMs = PEER_LIMITS.renewSeconds * 1000, onError = () => {} }) {
  const stopping = new AbortController();
  const running = new Map();
  const handlers = new Map();
  const refusedQueries = new Map();
  const background = new Set();
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
    // A visitor's query is answered here from shared knowledge; it never reaches a wake.
    const kind = claim.assertion?.protocol === PEER_QUERY_PROTOCOL ? QUERY : MESSAGE;
    let authorized;
    try {
      authorized = authorize(claim, kind);
    } catch (error) {
      store.setAttemptState(messageId, attemptId, 'rejected', error.code ?? 'rejected');
      // A query's sender learns one word whatever failed, on the same path: this
      // computer keeps the real code and records it, once the sending device was
      // proven, only after the answer went out.
      queue(messageId, attemptId, 'failed', { error: kind === QUERY ? QUERY_REFUSED : error.code ?? 'rejected' });
      const flushed = flush();
      if (kind === QUERY && error.device && firstRefusal(claim, error.device)) {
        inBackground(flushed.then(() => recordQueryRefusal(claim, error.device, error.code)));
      }
      return flushed;
    }
    if (stopping.signal.aborted) {
      store.setAttemptState(messageId, attemptId, 'not_started', 'stopped');
      queue(messageId, attemptId, 'never_started', { error: 'stopped' });
      return flush();
    }
    store.setAttemptState(messageId, attemptId, 'starting');
    const outcome = kind === QUERY
      ? await answerPeerQuery({ host, share: authorized.share, assertion: claim.assertion, device: authorized.device,
        deviceName: claim.sender.name })
      : await supervise(claim, authorized, acceptedAt);
    store.setAttemptState(messageId, attemptId, 'finished', outcome.outcome);
    queue(messageId, attemptId, outcome.outcome, outcome);
    return flush();
  }

  // Every check that decides whether this device may act, before any authority is issued.
  // A query is also tied to the coordinator's key for its assertion, so a claim
  // cannot run one assertion under another ID, and needs a host that answers queries.
  // device: the sending device's fingerprint, computed here from the certificate the
  // coordinator holds from pairing; that certificate signed the assertion and the
  // device's pinned origin authority signed its proof. Nothing the assertion says names it.
  // A refusal after this proof carries the proven device (error.device).
  function authorize(claim, kind) {
    const device = provenSender(claim, kind);
    try { return { ...permitted(claim, kind, device), device }; }
    catch (error) { error.device = device; throw error; }
  }

  // The sending device, proven: its certificate signed this assertion.
  function provenSender({ assertion, signature, sender }, { validate }) {
    validate(assertion, { now: clock() });
    const device = sender ? certificateFingerprint(sender.certPem) : null;
    if (!device || device !== sender.nodeId || assertion.from.node !== device) {
      throw new PeerError('sender_mismatch', 'The message sender does not match its device', 403);
    }
    if (!verifyDeviceSignature(sender.certPem, assertion, signature)) throw new PeerError('invalid_signature', 'Invalid device signature', 403);
    return device;
  }

  function permitted(claim, { purpose, visitor }, device) {
    const { assertion, sender } = claim;
    if (assertion.to.node !== nodeId) throw new PeerError('wrong_device', 'The message is for another device', 403);
    if (visitor && claim.messageId !== peerMessageKey(sender.nodeId, assertion.messageId)) {
      throw new PeerError('message_mismatch', 'The claim does not belong to this query', 403);
    }
    if (visitor && typeof host.searchSharedProject !== 'function') throw new PeerError('query_unsupported', 'This device does not answer queries', 403);
    // The coordinating computer knows its group: only its own active paired devices ask.
    const paired = visitor ? pairedDevices() : null;
    if (paired && !paired.has(device)) throw new PeerError('device_not_paired', 'The sending device is not paired with this computer', 403);
    const share = store.share(assertion.to.bindingId);
    if (!share || share.communicationOnly || share.agentId !== assertion.to.agentId || share.spaceId !== spaceId()) {
      throw new PeerError('agent_not_shared', 'That Agent is not shared on this device', 403);
    }
    const authority = pinnedAuthority(sender);
    const origin = verifyOriginProof(assertion, authority, { now: clock(), purpose });
    const earlier = store.attemptsFor(claim.messageId)
      .filter((attempt) => attempt.attempt_id !== claim.attemptId && STARTED_STATES.has(attempt.state));
    if (earlier.length) throw new PeerError('already_started', 'This message already started on this device', 409);
    return { share, origin };
  }

  // Recorded and counted against the proven device, so a flood shows, with the
  // project of the share the query named when this computer has that share.
  async function recordQueryRefusal(claim, device, code) {
    if (typeof host.refuseSharedQuery !== 'function') return;
    const share = store.share(claim.assertion.to.bindingId);
    await host.refuseSharedQuery({ action: claim.assertion.query.action, code: queryCode(code),
      ...(share?.spaceId === spaceId() ? { projectId: share.projectId } : {}),
      requester: { node: device, name: requesterLabel(claim.sender.name, device), agentName: null } });
  }

  // A refused query is remembered by its own key (the proven device and the
  // assertion's ID) until it and its proof have expired, so replaying it under
  // new attempt or claim IDs is refused again without being recorded or counted
  // twice. In memory, at most REFUSALS_REMEMBERED entries (oldest out first);
  // after a restart a replay inside that minute is recorded once more.
  function firstRefusal(claim, device) {
    const now = clock();
    for (const [key, until] of refusedQueries) if (until <= now) refusedQueries.delete(key);
    const key = peerMessageKey(device, claim.assertion.messageId);
    if (refusedQueries.has(key)) return false;
    refusedQueries.set(key, Date.parse(claim.assertion.expiresAt) + REFUSAL_SKEW_MS);
    if (refusedQueries.size > REFUSALS_REMEMBERED) refusedQueries.delete(refusedQueries.keys().next().value);
    return true;
  }

  // Work that follows an answer already sent: failures are logged like the runner's own.
  function inBackground(work) {
    const tracked = work.catch(onError).finally(() => background.delete(tracked));
    background.add(tracked);
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
        issueGrant: async (delivery, lifetime) => {
          if (claim.assertion.chatWake) {
            const current = await client.post('/peer/1/renew', { messageId, attemptId, state: 'starting' }, { signal: controller.signal });
            if (current.cancel) throw new PeerError('cancelled', 'Chat membership or sharing was revoked', 499);
          }
          return host.issueRemoteDelegation({ projectId: share.projectId, agentId: share.agentId,
          targetClient: delivery.client, targetSessionId: delivery.client === 'codex' ? delivery.sessionId : null,
          lifetimeSeconds: Math.max(30, Math.min(900, Math.round(lifetime))),
          originNode: claim.sender.nodeId, originMessageId: messageId, originAttemptId: attemptId }); } });
      if (controller.signal.aborted) throw new PeerError('cancelled', 'The delivery was stopped', 499);
      return { outcome: 'answered', reply: answer.body, via: answer.via, verified: true };
    } catch (error) {
      // A woken process whose exit could not be confirmed is reported with every outcome.
      const cleanup = peerCleanup(error.cleanup);
      const extra = cleanup ? { cleanup } : {};
      if (reason === 'lease_lost') return { outcome: 'unknown', error: 'lease_lost', ...extra };
      if (reason === 'cancelled' || reason === 'stopped' || error.code === 'cancelled') return { outcome: 'cancelled', error: reason ?? 'cancelled', ...extra };
      return { outcome: 'failed', error: error.code ?? 'wake_failed', ...extra };
    } finally {
      controller.abort('finished');
      clearTimeout(leaseTimer);
      stopping.signal.removeEventListener('abort', stopOnShutdown);
      running.delete(messageId);
      await renewals;
    }
  }

  function queue(messageId, attemptId, outcome, { reply = null, via = null, verified = false, error = null, cleanup = null } = {}) {
    store.queueResult(messageId, attemptId, { messageId, attemptId, outcome, reply, via, verified, error,
      ...(cleanup ? { cleanup } : {}) });
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
    await Promise.allSettled([...background]);
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
