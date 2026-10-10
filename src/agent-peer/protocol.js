import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const PEER_PROTOCOL = 'peer/1';
export const PEER_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  responseBytes: 1024 * 1024,
  messageChars: 16_000,
  queuePerNode: 100,
  directoryAgents: 50,
  defaultTtlSeconds: 30 * 60,
  maxTtlSeconds: 30 * 60,
  acceptSeconds: 15,
  leaseSeconds: 60,
  renewSeconds: 15,
  claimWaitMs: 20_000,
  maxDepth: 3,
  maxStartAttempts: 3,
  invitationSeconds: 10 * 60,
  executionSeconds: 900,
});
export const MESSAGE_STATUSES = Object.freeze(['queued', 'claimed', 'running', 'answered', 'failed', 'cancelled', 'expired', 'unknown']);
export const TERMINAL_STATUSES = new Set(['answered', 'failed', 'cancelled', 'expired', 'unknown']);
export const RESULT_OUTCOMES = new Set(['answered', 'failed', 'cancelled', 'unknown', 'never_started']);

const INVITATION_PREFIX = 'fuli-peer-invite:1:';
const FINGERPRINT = /^[0-9a-f]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class PeerError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function isFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT.test(value);
}

export function isOpaqueId(value) {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

// Persisted and signed times are compared as text, so only the canonical
// UTC form produced by Date#toISOString is accepted.
export function canonicalTime(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

export function shortFingerprint(fingerprint) {
  return fingerprint.slice(0, 24).toUpperCase().match(/.{4}/g).join(' ');
}

// Signatures cover a canonical form, so property order never changes meaning.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function coordinatorUrl(host, port) {
  if (!isIP(host)) throw new PeerError('invalid_address', 'The coordinator address must be an IP address');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new PeerError('invalid_address', 'Invalid coordinator port');
  return `https://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

export function encodeInvitation({ url, fingerprint, code, expiresAt, name, certificate, authority }) {
  const payload = { a: url, f: fingerprint, c: code, e: expiresAt, n: name, k: certificate, o: authority };
  return INVITATION_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url');
}

// An invitation carries the coordinator certificate, so the joining device
// trusts exactly that certificate from its first connection.
export function decodeInvitation(text, { now = Date.now() } = {}) {
  const value = String(text ?? '').trim();
  if (!value.startsWith(INVITATION_PREFIX) || value.length > 8192) {
    throw new PeerError('invalid_invitation', 'This is not a FULI device invitation');
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(value.slice(INVITATION_PREFIX.length), 'base64url').toString('utf8')); }
  catch { throw new PeerError('invalid_invitation', 'This is not a FULI device invitation'); }
  const url = parseCoordinatorUrl(payload?.a);
  if (!isFingerprint(payload?.f) || typeof payload?.c !== 'string' || payload.c.length < 32 || payload.c.length > 128
    || typeof payload?.k !== 'string' || typeof payload?.e !== 'string'
    || typeof payload?.o?.keyId !== 'string' || typeof payload?.o?.publicKey !== 'string') {
    throw new PeerError('invalid_invitation', 'This is not a FULI device invitation');
  }
  const certificate = Buffer.from(payload.k, 'base64');
  if (sha256Hex(certificate) !== payload.f) throw new PeerError('invalid_invitation', 'The invitation fingerprint does not match its certificate');
  if (!(canonicalTime(payload.e) > now)) throw new PeerError('invitation_expired', 'This invitation has expired', 410);
  return { url, fingerprint: payload.f, code: payload.c, expiresAt: payload.e,
    name: typeof payload.n === 'string' ? payload.n.slice(0, 80) : '', certificatePem: derToPem(certificate),
    authority: { keyId: payload.o.keyId, publicKey: payload.o.publicKey } };
}

export function parseCoordinatorUrl(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw new PeerError('invalid_address', 'Invalid coordinator address'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || !isIP(host) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new PeerError('invalid_address', 'The coordinator address must be https://IP:port');
  }
  return url.origin;
}

export function derToPem(der) {
  return `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

export function pemToDer(pem) {
  const body = String(pem ?? '').match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/)?.[1];
  if (!body) throw new PeerError('invalid_certificate', 'Invalid device certificate');
  return Buffer.from(body.replace(/\s+/g, ''), 'base64');
}

// The signed request a sending device makes on behalf of one verified local task.
export function validateAssertion(assertion, { now = Date.now() } = {}) {
  const fail = (message) => { throw new PeerError('invalid_message', message); };
  if (!assertion || typeof assertion !== 'object' || assertion.protocol !== PEER_PROTOCOL) fail('Unsupported message protocol');
  if (!isOpaqueId(assertion.messageId) || !isOpaqueId(assertion.threadId)) fail('Invalid message identity');
  const { from, to } = assertion;
  if (!isFingerprint(from?.node) || !isOpaqueId(from?.agentId) || typeof from?.name !== 'string' || from.name.length > 120) fail('Invalid sender');
  if (!isFingerprint(to?.node) || !isOpaqueId(to?.bindingId) || !isOpaqueId(to?.agentId)) fail('Invalid recipient');
  if (from.node === to.node) fail('A device cannot send a remote message to itself');
  if (typeof assertion.body !== 'string' || !assertion.body.trim() || assertion.body.length > PEER_LIMITS.messageChars) fail('Invalid message body');
  if (!['auto', 'new'].includes(assertion.conversation)) fail('Invalid conversation policy');
  if (!Number.isSafeInteger(assertion.depth) || assertion.depth < 1 || assertion.depth > PEER_LIMITS.maxDepth) {
    throw new PeerError('budget_exceeded', 'This conversation reached its cross-device depth limit');
  }
  const origin = assertion.origin;
  if (!origin || typeof origin.payload !== 'string' || typeof origin.signature !== 'string'
    || origin.payload.length > 4096 || origin.signature.length > 128 || Object.keys(origin).length !== 2) {
    fail('A remote message needs its origin proof');
  }
  const issued = canonicalTime(assertion.issuedAt);
  const expires = canonicalTime(assertion.expiresAt);
  if (issued === null || expires === null) fail('Message times must be canonical UTC ISO timestamps');
  if (!(issued <= now + 60_000) || !(expires > issued) || expires - issued > PEER_LIMITS.maxTtlSeconds * 1000) fail('Invalid message lifetime');
  if (expires <= now) throw new PeerError('message_expired', 'This message has expired', 410);
  return assertion;
}

export function publicDirectoryEntry(entry) {
  if (!isOpaqueId(entry?.bindingId) || !isOpaqueId(entry?.agentId)) throw new PeerError('invalid_directory', 'Invalid shared Agent');
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;
  return { bindingId: entry.bindingId, agentId: entry.agentId, name: text(entry.name, 120) ?? entry.agentId,
    employeeNumber: text(entry.employeeNumber, 32), responsibility: text(entry.responsibility, 500),
    projectName: text(entry.projectName, 120),
    clients: (Array.isArray(entry.clients) ? entry.clients : []).filter((client) => isOpaqueId(client)).slice(0, 4) };
}
