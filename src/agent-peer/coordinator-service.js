import { randomBytes, randomUUID } from 'node:crypto';

import { certificateFingerprint, verifyDeviceSignature } from './device-identity.js';
import { isAuthorityKey } from './origin-proof.js';
import {
  canonicalJson, encodeInvitation, PEER_LIMITS, PeerError, pemToDer, publicDirectoryEntry,
  RESULT_OUTCOMES, sha256Hex, TERMINAL_STATUSES, validateAssertion,
} from './protocol.js';

const ONLINE_MS = 90_000;
const PAIRING_FAILURE_WINDOW_MS = 10 * 60_000;
const PAIRING_FAILURE_LIMIT = 10;

// Routes messages between paired devices. It never executes anything: each
// receiving device re-checks its own shares and identity authority.
export function createCoordinatorService({ store, identity, authority, name, clock = Date.now,
  randomCode = () => randomBytes(32).toString('base64url'), idFactory = randomUUID, onTrustChange = () => {} }) {
  const iso = (offsetMs = 0) => new Date(clock() + offsetMs).toISOString();
  const pairingFailures = [];
  if (!isAuthorityKey(authority)) throw new PeerError('authority_unavailable', 'The coordinator needs its local origin authority', 500);
  store.upsertNode({ id: identity.fingerprint, name, certPem: identity.certPem, authority, at: iso() });

  function createInvitation({ url }) {
    const code = randomCode();
    const expiresAt = iso(PEER_LIMITS.invitationSeconds * 1000);
    store.createInvitation({ codeHash: sha256Hex(code), at: iso(), expiresAt });
    return { invitation: encodeInvitation({ url, fingerprint: identity.fingerprint, code, expiresAt, name, authority,
      certificate: pemToDer(identity.certPem).toString('base64') }), fingerprint: identity.fingerprint, expiresAt };
  }

  function pair({ code, certPem, name: deviceName, authority: deviceAuthority }) {
    const now = clock();
    while (pairingFailures.length && pairingFailures[0] < now - PAIRING_FAILURE_WINDOW_MS) pairingFailures.shift();
    if (pairingFailures.length >= PAIRING_FAILURE_LIMIT) throw new PeerError('pairing_rate_limited', 'Too many failed pairing attempts; try again later', 429);
    const fingerprint = certificateFingerprint(certPem);
    if (fingerprint === identity.fingerprint) throw new PeerError('invalid_pairing', 'A device cannot pair with itself', 400);
    const codeHash = typeof code === 'string' && code.length <= 128 ? sha256Hex(code) : null;
    const invitation = codeHash ? store.invitation(codeHash) : null;
    const usable = invitation && !invitation.used_at && Date.parse(invitation.expires_at) > now;
    if (!usable) {
      pairingFailures.push(now);
      throw new PeerError('invalid_pairing_code', 'This invitation is invalid, expired or already used', 403);
    }
    if (!isAuthorityKey(deviceAuthority)) throw new PeerError('invalid_pairing', 'The device did not present its origin authority', 400);
    const label = cleanName(deviceName) || `FULI device ${fingerprint.slice(0, 8)}`;
    store.transaction(() => {
      if (!store.useInvitation(codeHash, fingerprint, iso())) throw new PeerError('invalid_pairing_code', 'This invitation was already used', 403);
      store.upsertNode({ id: fingerprint, name: label, certPem,
        authority: { keyId: deviceAuthority.keyId, publicKey: deviceAuthority.publicKey }, at: iso() });
    });
    onTrustChange();
    return { nodeId: fingerprint, coordinatorNodeId: identity.fingerprint, coordinatorName: name };
  }

  function authenticate(nodeId) {
    const node = store.node(nodeId);
    if (!node || node.status !== 'active') throw new PeerError('device_not_trusted', 'This device is not paired or was revoked', 403);
    store.touchNode(nodeId, iso());
    return node;
  }

  function publishDirectory(nodeId, { agents }) {
    if (!Array.isArray(agents) || agents.length > PEER_LIMITS.directoryAgents) throw new PeerError('invalid_directory', 'Invalid shared Agent list');
    const entries = agents.map(publicDirectoryEntry);
    store.setDirectory(nodeId, entries);
    return { published: entries.length };
  }

  function directory(nodeId) {
    const now = clock();
    return { devices: store.nodes().filter((node) => node.status === 'active' && node.id !== nodeId).map((node) => ({
      nodeId: node.id, name: node.name,
      online: Boolean(node.last_seen_at) && now - Date.parse(node.last_seen_at) < ONLINE_MS,
      agents: JSON.parse(node.directory_json),
    })) };
  }

  function submit(nodeId, { assertion, signature }) {
    validateAssertion(assertion, { now: clock() });
    if (assertion.from.node !== nodeId) throw new PeerError('sender_mismatch', 'The message sender is not this device', 403);
    const sender = store.node(nodeId);
    if (!verifyDeviceSignature(sender.cert_pem, assertion, signature)) throw new PeerError('invalid_signature', 'The message signature is invalid', 403);
    const target = store.node(assertion.to.node);
    if (!target || target.status !== 'active') throw new PeerError('device_unavailable', 'The receiving device is not paired', 404);
    const shared = JSON.parse(target.directory_json)
      .some((entry) => entry.bindingId === assertion.to.bindingId && entry.agentId === assertion.to.agentId);
    if (!shared) throw new PeerError('agent_not_shared', 'That Agent is not shared by the receiving device', 404);
    const assertionJson = canonicalJson(assertion);
    return store.transaction(() => {
      const key = messageKey(nodeId, assertion.messageId);
      const existing = store.message(key);
      if (existing) {
        if (existing.assertion_json !== assertionJson) {
          throw new PeerError('duplicate_message', 'A different message already uses this ID', 409);
        }
        return statusView(existing);
      }
      if (store.queuedCount(target.id) >= PEER_LIMITS.queuePerNode) throw new PeerError('queue_full', 'The receiving device has too many waiting messages', 429);
      store.insertMessage({ id: key, senderNode: nodeId, targetNode: target.id,
        bindingId: assertion.to.bindingId, assertionJson, signature, expiresAt: assertion.expiresAt, at: iso() });
      return statusView(store.message(key));
    });
  }

  function claim(nodeId) {
    return store.transaction(() => {
      const next = store.nextQueued(nodeId, iso());
      if (!next) return null;
      const attemptId = idFactory();
      // A short acceptance window: the runner may only start after its acceptance is recorded.
      store.updateMessage(next.id, { status: 'claimed', attempt_id: attemptId, accepted_attempt: null,
        start_attempts: next.start_attempts + 1, lease_expires_at: iso(PEER_LIMITS.acceptSeconds * 1000) }, iso(), 'claimed', attemptId);
      const sender = store.node(next.sender_node);
      return { messageId: next.id, attemptId, leaseSeconds: PEER_LIMITS.leaseSeconds,
        assertion: JSON.parse(next.assertion_json), signature: next.signature,
        sender: { nodeId: sender.id, name: sender.name, certPem: sender.cert_pem,
          authority: sender.authority_json ? JSON.parse(sender.authority_json) : null } };
    });
  }

  function currentAttempt(nodeId, messageId, attemptId) {
    const message = store.message(messageId);
    if (!message || message.target_node !== nodeId) throw new PeerError('message_not_found', 'No such message for this device', 404);
    if (message.attempt_id !== attemptId) throw new PeerError('attempt_not_current', 'This delivery attempt is no longer current', 409);
    return message;
  }

  function renew(nodeId, { messageId, attemptId, state }) {
    if (!['accepted', 'starting', 'running'].includes(state)) throw new PeerError('invalid_state', 'Unknown attempt state');
    return store.transaction(() => {
      const message = currentAttempt(nodeId, messageId, attemptId);
      if (!['claimed', 'running'].includes(message.status)) throw new PeerError('attempt_not_current', 'This delivery attempt is no longer active', 409);
      if (!(Date.parse(message.lease_expires_at) > clock())) throw new PeerError('lease_expired', 'This delivery attempt lost its lease', 409);
      const accepted = message.accepted_attempt === attemptId;
      if (!accepted && state !== 'accepted') throw new PeerError('attempt_not_accepted', 'Accept the attempt before starting it', 409);
      const changes = { lease_expires_at: iso(PEER_LIMITS.leaseSeconds * 1000) };
      if (!accepted) changes.accepted_attempt = attemptId;
      if (state === 'running' && message.status === 'claimed') changes.status = 'running';
      store.updateMessage(messageId, changes, iso(), changes.status ? 'started' : accepted ? 'renewed' : 'accepted', attemptId);
      return { cancel: message.cancel_requested === 1 || Date.parse(message.expires_at) <= clock() };
    });
  }

  function result(nodeId, { messageId, attemptId, outcome, reply = null, error = null, via = null, verified = false }) {
    if (!RESULT_OUTCOMES.has(outcome)) throw new PeerError('invalid_result', 'Unknown result outcome');
    if (outcome === 'answered' && (typeof reply !== 'string' || !reply.trim() || reply.length > 64_000 || verified !== true)) {
      throw new PeerError('invalid_result', 'An answer needs a verified reply');
    }
    return store.transaction(() => {
      const message = currentAttempt(nodeId, messageId, attemptId);
      if (TERMINAL_STATUSES.has(message.status) && message.status !== 'unknown') return statusView(message);
      const detail = typeof error === 'string' ? error.slice(0, 120) : null;
      if (outcome === 'never_started') {
        // Only an attempt whose acceptance was never recorded is proof that nothing started.
        // Once accepted, the receiver may have lost the acknowledgement, so the outcome is unknown.
        const started = message.status === 'running'
          || store.events(messageId).some((event) => event.kind === 'started' && event.detail === attemptId);
        if (started) throw new PeerError('attempt_started', 'This attempt already started', 409);
        if (message.accepted_attempt === attemptId) {
          store.updateMessage(messageId, { status: 'unknown', error: 'accepted_without_start', lease_expires_at: null },
            iso(), 'unknown', attemptId);
        } else releaseUnstarted(message, detail);
      } else {
        store.updateMessage(messageId, { status: outcome, error: outcome === 'answered' ? null : detail,
          reply: outcome === 'answered' ? reply : null, via: typeof via === 'string' ? via.slice(0, 80) : null,
          verified: verified === true ? 1 : 0, lease_expires_at: null }, iso(), outcome, attemptId);
      }
      return statusView(store.message(messageId));
    });
  }

  function addressed(nodeId, messageId) {
    if (typeof messageId !== 'string' || messageId.length > 128) return null;
    const sent = store.message(messageKey(nodeId, messageId));
    if (sent) return sent;
    const received = store.message(messageId);
    return received?.target_node === nodeId ? received : null;
  }

  function status(nodeId, { messageId }) {
    const message = addressed(nodeId, messageId);
    if (!message) {
      throw new PeerError('message_not_found', 'No such message for this device', 404);
    }
    return statusView(message);
  }

  function cancel(nodeId, { messageId }) {
    return store.transaction(() => {
      const message = typeof messageId === 'string' ? store.message(messageKey(nodeId, messageId)) : null;
      if (!message) throw new PeerError('message_not_found', 'No such message sent by this device', 404);
      if (message.status === 'queued') store.updateMessage(message.id, { status: 'cancelled', error: 'cancelled' }, iso(), 'cancelled');
      else if (['claimed', 'running'].includes(message.status)) store.updateMessage(message.id, { cancel_requested: 1 }, iso(), 'cancel_requested');
      return statusView(store.message(message.id));
    });
  }

  function revoke(nodeId) {
    if (nodeId === identity.fingerprint) throw new PeerError('invalid_revoke', 'The coordinator cannot revoke itself');
    store.transaction(() => {
      store.revokeNode(nodeId, iso());
      for (const message of store.openForNode(nodeId)) {
        if (message.status === 'queued') store.updateMessage(message.id, { status: 'cancelled', error: 'device_revoked' }, iso(), 'revoked');
        else store.updateMessage(message.id, { cancel_requested: 1 }, iso(), 'cancel_requested', 'device_revoked');
      }
    });
    onTrustChange();
    return { revoked: true };
  }

  function releaseUnstarted(message, detail) {
    const changes = message.cancel_requested ? { status: 'cancelled', error: 'cancelled' }
      : Date.parse(message.expires_at) <= clock() ? { status: 'expired', error: 'expired' }
      : message.start_attempts >= PEER_LIMITS.maxStartAttempts ? { status: 'failed', error: detail ?? 'start_attempts_exhausted' }
      : { status: 'queued', error: detail };
    store.updateMessage(message.id, { ...changes, attempt_id: null, accepted_attempt: null, lease_expires_at: null },
      iso(), `never_started:${changes.status}`, message.attempt_id);
  }

  // An attempt the coordinator never accepted cannot have started, because a
  // runner only starts after acceptance is confirmed. Once accepted, a lapsed
  // lease is uncertain and becomes unknown, never "not started".
  function sweep() {
    store.transaction(() => {
      for (const message of store.expiredQueued(iso())) store.updateMessage(message.id, { status: 'expired', error: 'expired' }, iso(), 'expired');
      for (const message of store.staleLeases(iso())) {
        if (message.accepted_attempt !== message.attempt_id) releaseUnstarted(message, 'not_accepted');
        else store.updateMessage(message.id, { status: 'unknown', error: 'lease_expired', lease_expires_at: null }, iso(), 'unknown', message.attempt_id);
      }
    });
  }

  function devices() {
    const now = clock();
    return store.nodes().map((node) => ({ nodeId: node.id, name: node.name, status: node.status,
      self: node.id === identity.fingerprint, pairedAt: node.paired_at, revokedAt: node.revoked_at,
      online: node.id === identity.fingerprint || (Boolean(node.last_seen_at) && now - Date.parse(node.last_seen_at) < ONLINE_MS),
      sharedAgents: JSON.parse(node.directory_json).length }));
  }

  return { createInvitation, pair, authenticate, publishDirectory, directory, submit, claim, renew, result,
    status, cancel, revoke, sweep, devices, trustedCertificates: () => store.activeCertificates(),
    openInvitations: () => store.openInvitations(iso()).length };
}

// Message IDs are chosen by senders, so the coordinator keys them per sending device.
function messageKey(senderNode, messageId) {
  return sha256Hex(`${senderNode}:${messageId}`);
}

function statusView(message) {
  return { messageId: JSON.parse(message.assertion_json).messageId, status: message.status, reply: message.reply ?? null, error: message.error ?? null,
    via: message.via ?? null, verified: message.verified === 1, updatedAt: message.updated_at };
}

export function cleanName(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
}
