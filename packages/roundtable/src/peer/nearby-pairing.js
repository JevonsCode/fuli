import { randomBytes, randomUUID } from 'node:crypto';

import { cleanName } from './coordinator-service.js';
import { isAuthorityKey } from './origin-proof.js';
import { PeerError, sha256Hex, shortFingerprint } from './protocol.js';

export const NEARBY_PROTOCOL = 1;
const PAIRING_MS = 2 * 60_000;
const POLL_MS = 1_000;
const REQUEST_MS = 5_000;
const FAILURE_WINDOW_MS = 10 * 60_000;
const FAILURE_LIMIT = 10;
const COMMITMENT = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const OPEN_STATES = new Set(['connecting', 'confirm', 'finishing']);

// Pairing two computers that see each other on the LAN, with a 6-digit code
// each person compares by eye and confirms on their own computer (rec issue 127).
//
// Threat model. Anyone on the LAN sees the advertisement and can reach these
// routes, so:
// - A request alone changes nothing. Trust is written only after the person on
//   each computer confirmed (a loopback-only control); until then the request
//   lives in memory, one at a time, and is gone after 2 minutes.
// - The code is derived from both full certificate fingerprints, the chosen
//   coordinator and a fresh nonce from each side. The initiator commits to its
//   nonce before it sees the target's, so a device in the middle cannot pick
//   nonces that make both screens show the same code: it wins 1 in 10^6 per
//   attempt, and failed attempts are rate-limited and each shows on the screens.
// - A wrong commitment, or a code that differs from this computer's, cancels the
//   request. There is no weaker fallback: an unknown protocol version is refused.
// - Paired devices get the same mutual-TLS and origin-authority records an
//   invitation writes; a device already trusted, or this device itself, is refused.
//
// Which computer coordinates is not the person's choice: the one that already
// coordinates other devices keeps doing so; otherwise the computer that was
// picked from the list (the target), since the initiator just proved it can
// reach it. Two computers that both coordinate others are refused.
export function createNearbyPairing({ local, connect, clock = Date.now, nonce = () => randomBytes(32).toString('base64url'),
  idFactory = randomUUID, pollMs = POLL_MS, onError = () => {} }) {
  let slot = null;
  const failures = [];

  function sweep() {
    if (!slot) return;
    const now = clock();
    if (OPEN_STATES.has(slot.state) && slot.expiresAt <= now) end(slot, slot.applied ? 'paired' : 'expired', slot.applied ? null : 'expired');
    else if (!OPEN_STATES.has(slot.state) && slot.endedAt + PAIRING_MS <= now) slot = null;
  }

  function open() {
    sweep();
    return slot && OPEN_STATES.has(slot.state) ? slot : null;
  }

  function end(current, state, reason = null) {
    current.state = state;
    current.reason = reason;
    current.endedAt = clock();
    clearTimeout(current.timer);
    current.client?.close();
    current.client = null;
  }

  function limitFailures() {
    const now = clock();
    while (failures.length && failures[0] < now - FAILURE_WINDOW_MS) failures.shift();
    if (failures.length >= FAILURE_LIMIT) throw new PeerError('pairing_rate_limited', 'Too many failed pairing attempts; try again later', 429);
  }

  function refuse(code, message, status = 400) {
    failures.push(clock());
    return new PeerError(code, message, status);
  }

  function codeOf(current) {
    const [initiator, target] = current.direction === 'outgoing' ? [current.self, current.peer.fingerprint]
      : [current.peer.fingerprint, current.self];
    const digest = sha256Hex(['fuli-pair-code', NEARBY_PROTOCOL, initiator, target, current.coordinator,
      current.initiatorNonce, current.targetNonce].join('|'));
    return String(Number.parseInt(digest.slice(0, 8), 16) % 1_000_000).padStart(6, '0');
  }

  // ---- The computer that was picked (target): routes on its listener ----

  async function receiveRequest(body, peer) {
    limitFailures();
    if (body.protocol !== NEARBY_PROTOCOL) throw refuse('unsupported_protocol', 'This FULI pairs with nearby protocol 1 only');
    const role = local.role();
    if (!role.listening) throw new PeerError('nearby_off', 'This computer is not open for nearby pairing', 404);
    const self = await local.identity();
    const authority = await local.authority();
    if (peer.fingerprint === self.fingerprint) throw refuse('invalid_pairing', 'A device cannot pair with itself');
    if (local.trusted(peer.fingerprint)) throw new PeerError('already_paired', 'These computers are already paired', 409);
    if (!COMMITMENT.test(body.commit ?? '') || !isAuthorityKey(body.authority) || typeof body.coordinates !== 'boolean'
      || (body.coordinates && !validPort(body.port))) throw refuse('invalid_pairing', 'Invalid nearby pairing request');
    if (body.coordinates && role.coordinatesOthers) {
      throw new PeerError('both_coordinate', 'Both computers already coordinate other devices; turn the LAN roundtable off on one first', 409);
    }
    if (open()) throw new PeerError('pairing_busy', 'This computer is already pairing; try again in two minutes', 409);
    slot = { id: idFactory(), direction: 'incoming', self: self.fingerprint, state: 'connecting',
      peer: { fingerprint: peer.fingerprint, certPem: peer.certPem, name: cleanName(body.name) || `FULI ${peer.fingerprint.slice(0, 4)}`,
        authority: { keyId: body.authority.keyId, publicKey: body.authority.publicKey }, address: peer.address,
        port: body.coordinates ? body.port : null },
      coordinator: body.coordinates ? 'initiator' : 'target', commit: body.commit, targetNonce: nonce(),
      expiresAt: clock() + PAIRING_MS, here: false, there: false, applied: false };
    return { value: { protocol: NEARBY_PROTOCOL, requestId: slot.id, nonce: slot.targetNonce, name: local.name(), authority,
      coordinator: slot.coordinator, expiresAt: new Date(slot.expiresAt).toISOString() } };
  }

  function incoming(requestId, peer) {
    sweep();
    if (!slot || slot.direction !== 'incoming' || slot.id !== requestId || slot.peer.fingerprint !== peer.fingerprint) {
      throw new PeerError('pairing_not_found', 'This pairing request is no longer open', 404);
    }
    return slot;
  }

  function receiveReveal(body, peer) {
    const current = incoming(body.requestId, peer);
    if (!OPEN_STATES.has(current.state)) throw new PeerError('pairing_not_found', 'This pairing request is no longer open', 404);
    if (current.state !== 'connecting' || typeof body.nonce !== 'string' || sha256Hex(commitmentText(body.nonce)) !== current.commit) {
      end(current, 'failed', 'code_mismatch');
      throw refuse('pairing_mismatch', 'The pairing answer does not match its commitment', 403);
    }
    current.initiatorNonce = body.nonce;
    current.code = codeOf(current);
    current.state = 'confirm';
    return { value: { state: 'confirm' } };
  }

  async function receivePoll(body, peer) {
    const current = incoming(body.requestId, peer);
    if (!OPEN_STATES.has(current.state)) return { value: { state: current.state, reason: current.reason ?? null } };
    if (body.cancel === true) {
      end(current, 'cancelled', 'cancelled_there');
      return { value: { state: 'cancelled' } };
    }
    current.there = body.confirmed === true;
    if (current.state === 'connecting' || !(current.here && current.there)) return { value: { state: current.state, confirmed: current.here } };
    if (current.coordinator === 'target') {
      current.applying ??= Promise.resolve().then(() => local.trustDevice(current.peer));
      try { await current.applying; }
      catch (error) {
        if (OPEN_STATES.has(current.state)) end(current, 'failed', error.code ?? 'trust_failed');
        onError(error);
        return { value: { state: 'failed', reason: error.code ?? 'trust_failed' } };
      }
      if (OPEN_STATES.has(current.state)) { current.applied = true; end(current, 'paired'); }
      return { value: { state: current.state, reason: current.reason ?? null } };
    }
    if (body.applied !== true) {
      current.state = 'finishing';
      return { value: { state: 'confirmed', confirmed: true } };
    }
    // This computer joins the initiator: first check that it answers where it said.
    if (!await local.reachable(current.peer).catch(() => false)) {
      end(current, 'failed', 'coordinator_unreachable');
      return { value: { state: 'failed', reason: 'coordinator_unreachable' } };
    }
    current.applied = true;
    end(current, 'paired');
    return { value: { state: 'paired' }, after: () => {
      Promise.resolve(local.joinCoordinator(current.peer)).catch((error) => {
        current.state = 'failed';
        current.reason = error.code ?? 'join_failed';
        onError(error);
      });
    } };
  }

  async function handle(pathname, body, peer) {
    switch (pathname) {
      case '/peer/1/nearby/request': return receiveRequest(body, peer);
      case '/peer/1/nearby/reveal': return receiveReveal(body, peer);
      case '/peer/1/nearby/poll': return receivePoll(body, peer);
      default: throw new PeerError('not_found', 'Not found', 404);
    }
  }

  // ---- The computer where the person clicked 配对 (initiator) ----

  async function start(target) {
    const role = local.role();
    if (!role.listening) throw new PeerError('nearby_unavailable', role.reason ?? 'Turn nearby pairing on first', 409);
    if (open()) throw new PeerError('pairing_busy', 'A pairing is already waiting for confirmation', 409);
    const current = { id: null, direction: 'outgoing', state: 'connecting', expiresAt: clock() + PAIRING_MS,
      peer: { name: target.name, fingerprint: null, shortFingerprint: target.shortFingerprint },
      coordinator: role.coordinatesOthers ? 'initiator' : 'target', here: false, there: false, applied: false };
    slot = current;
    const stillOpen = () => {
      if (current.state !== 'connecting') throw new PeerError('pairing_cancelled', 'The pairing was cancelled', 409);
    };
    try {
      current.client = await connect(target);
      stillOpen();
      if (local.trusted(current.client.fingerprint)) throw new PeerError('already_paired', 'These computers are already paired', 409);
      const self = await local.identity();
      const authority = await local.authority();
      const initiatorNonce = nonce();
      const answer = await current.client.post('/peer/1/nearby/request', { protocol: NEARBY_PROTOCOL,
        commit: sha256Hex(commitmentText(initiatorNonce)), name: local.name(), authority, coordinates: role.coordinatesOthers,
        ...(role.coordinatesOthers ? { port: role.listenPort } : {}) }, { timeoutMs: REQUEST_MS });
      stillOpen();
      if (answer.protocol !== NEARBY_PROTOCOL || !REQUEST_ID.test(answer.requestId ?? '') || !NONCE.test(answer.nonce ?? '')
        || !isAuthorityKey(answer.authority) || answer.coordinator !== current.coordinator) {
        throw new PeerError('invalid_pairing', 'The nearby computer answered with an invalid pairing request', 502);
      }
      Object.assign(current, { id: answer.requestId, self: self.fingerprint, initiatorNonce, targetNonce: answer.nonce,
        peer: { fingerprint: current.client.fingerprint, certPem: current.client.certPem,
          name: cleanName(answer.name) || target.name, authority: { keyId: answer.authority.keyId, publicKey: answer.authority.publicKey },
          address: current.client.address, port: current.client.port } });
      await current.client.post('/peer/1/nearby/reveal', { requestId: current.id, nonce: initiatorNonce }, { timeoutMs: REQUEST_MS });
      stillOpen();
      current.code = codeOf(current);
      current.state = 'confirm';
      schedulePoll(current);
    } catch (error) {
      if (OPEN_STATES.has(current.state)) end(current, 'failed', error.code ?? 'pairing_failed');
      throw error;
    }
    return view();
  }

  function schedulePoll(current, delayMs = pollMs) {
    clearTimeout(current.timer);
    current.timer = setTimeout(() => poll(current).catch((error) => {
      onError(error);
      if (OPEN_STATES.has(current.state)) end(current, 'failed', error.code ?? 'pairing_failed');
    }), delayMs);
    current.timer.unref?.();
  }

  async function poll(current) {
    if (!OPEN_STATES.has(current.state)) return;
    if (current.expiresAt <= clock()) { sweep(); return; }
    let answer;
    try {
      answer = await current.client.post('/peer/1/nearby/poll', { requestId: current.id, confirmed: current.here,
        applied: current.applied }, { timeoutMs: REQUEST_MS });
    } catch (error) {
      if (!OPEN_STATES.has(current.state)) return;
      if (error.status === 404 && !current.applied) { end(current, 'cancelled', 'cancelled_there'); return; }
      schedulePoll(current);
      return;
    }
    if (!OPEN_STATES.has(current.state)) return;
    current.there = answer.confirmed === true || answer.state === 'paired';
    if (answer.state === 'paired') {
      if (current.coordinator === 'target') await local.joinCoordinator(current.peer);
      end(current, 'paired');
      return;
    }
    if (['failed', 'cancelled', 'expired'].includes(answer.state)) {
      if (current.applied) await local.untrustDevice(current.peer.fingerprint);
      end(current, answer.state === 'failed' ? 'failed' : 'cancelled', typeof answer.reason === 'string' ? answer.reason.slice(0, 40) : 'cancelled_there');
      return;
    }
    if (answer.state === 'confirmed' && current.coordinator === 'initiator' && current.here && !current.applied) {
      current.state = 'finishing';
      await local.trustDevice(current.peer);
      current.applied = true;
      schedulePoll(current, 0);
      return;
    }
    schedulePoll(current);
  }

  // ---- The person's own controls on either computer (loopback only) ----

  function confirm({ requestId, code }) {
    const current = open();
    if (!current || current.id !== requestId) throw new PeerError('pairing_not_found', 'No pairing is waiting for confirmation here', 404);
    if (current.state !== 'confirm') throw new PeerError('pairing_not_ready', 'The pairing code is not ready yet', 409);
    if (String(code ?? '').replace(/\s+/g, '') !== current.code) {
      stop(current, 'code_mismatch');
      throw new PeerError('code_mismatch', 'That code is not the one on this computer; the pairing was cancelled', 409);
    }
    current.here = true;
    if (current.direction === 'outgoing') schedulePoll(current, 0);
    return view();
  }

  function cancel() {
    const current = open();
    if (current) stop(current, 'cancelled_here');
    return view();
  }

  // Tells the other computer when this one started the pairing; the target's
  // side is seen by the initiator on its next poll.
  function stop(current, reason) {
    const { client, id } = current;
    current.client = null;
    end(current, reason === 'code_mismatch' ? 'failed' : 'cancelled', reason);
    if (!client) return;
    if (!id) { client.close(); return; }
    client.post('/peer/1/nearby/poll', { requestId: id, cancel: true }, { timeoutMs: REQUEST_MS })
      .catch(() => {}).finally(() => client.close());
  }

  function view() {
    sweep();
    if (!slot) return null;
    const fingerprint = slot.peer.fingerprint;
    const thisCoordinates = (slot.coordinator === 'target') === (slot.direction === 'incoming');
    return { requestId: slot.id, direction: slot.direction, state: slot.state, reason: slot.reason ?? null,
      device: { name: slot.peer.name, shortFingerprint: fingerprint ? shortFingerprint(fingerprint) : slot.peer.shortFingerprint ?? null },
      code: ['confirm', 'finishing'].includes(slot.state) ? slot.code : null,
      coordinator: thisCoordinates ? 'this' : 'other', confirmedHere: slot.here, confirmedThere: slot.there,
      expiresAt: new Date(slot.expiresAt).toISOString() };
  }

  function close() {
    if (slot && OPEN_STATES.has(slot.state)) stop(slot, 'cancelled_here');
    slot = null;
  }

  return { handle, start, confirm, cancel, view, close };
}

function commitmentText(nonce) {
  return `fuli-pair-commit:${NEARBY_PROTOCOL}:${nonce}`;
}

function validPort(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 65535;
}
