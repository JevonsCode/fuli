import { createPublicKey, verify } from 'node:crypto';

import { canonicalJson, canonicalTime, PeerError, sha256Hex } from './protocol.js';

const PROOF_VERSION = 'fuli-remote-origin/1';
const CLOCK_SKEW_MS = 60_000;

// The digest the sending Provider signs: the whole message except the proof itself.
export function assertionDigest(assertion) {
  const { origin: _origin, ...signed } = assertion;
  return sha256Hex(canonicalJson(signed));
}

export function isAuthorityKey(value) {
  return Boolean(value) && typeof value.keyId === 'string' && /^[0-9a-f]{32}$/.test(value.keyId)
    && typeof value.publicKey === 'string' && Buffer.from(value.publicKey, 'base64url').length === 32;
}

export function authorityFromProvider(response) {
  const key = { keyId: response?.key_id, publicKey: response?.public_key };
  if (response?.algorithm !== 'Ed25519' || !isAuthorityKey(key)) {
    throw new PeerError('authority_unavailable', 'The local FULI authority returned an invalid origin key', 502);
  }
  return key;
}

// A device signature only proves which installation relayed a message. This
// proves the sender's own FULI authority let its current project lead send
// exactly this message to exactly this binding, until a short expiry.
export function verifyOriginProof(assertion, authority, { now = Date.now() } = {}) {
  const fail = (message) => { throw new PeerError('origin_rejected', message, 403); };
  if (!isAuthorityKey(authority)) fail('No origin authority was bound when this device was paired');
  const proof = assertion?.origin;
  if (typeof proof?.payload !== 'string' || typeof proof?.signature !== 'string'
    || proof.payload.length > 4096 || proof.signature.length > 128) fail('The message has no origin proof');
  const payload = Buffer.from(proof.payload, 'base64url');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: authority.publicKey }, format: 'jwk' });
  let valid = false;
  try { valid = verify(null, payload, key, Buffer.from(proof.signature, 'base64url')); } catch { valid = false; }
  if (!valid) fail('The origin proof signature is invalid');
  let claims;
  try { claims = JSON.parse(payload.toString('utf8')); } catch { fail('The origin proof is malformed'); }
  if (claims?.version !== PROOF_VERSION || claims.key_id !== authority.keyId) fail('The origin proof uses another authority');
  if (claims.digest !== assertionDigest(assertion)) fail('The origin proof covers a different message');
  if (claims.message_id !== assertion.messageId || claims.agent_id !== assertion.from.agentId
    || claims.target_node !== assertion.to.node || claims.binding_id !== assertion.to.bindingId
    || claims.expires_at !== assertion.expiresAt) fail('The origin proof does not match the message');
  if (typeof claims.space_id !== 'string' || typeof claims.project_id !== 'string' || typeof claims.task_hash !== 'string') {
    fail('The origin proof has no source scope');
  }
  const issued = canonicalTime(claims.issued_at);
  const expires = canonicalTime(claims.expires_at);
  if (issued === null || expires === null || issued > now + CLOCK_SKEW_MS) fail('The origin proof has invalid times');
  if (expires <= now) throw new PeerError('origin_expired', 'The origin proof has expired', 410);
  return { spaceId: claims.space_id, projectId: claims.project_id, agentId: claims.agent_id, taskHash: claims.task_hash };
}
