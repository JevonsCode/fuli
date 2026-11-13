import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const PEER_PROTOCOL = 'peer/1';
// A visitor's read-only question to a shared lead's project (the visiting
// assistant): rides the same queue as a message but never wakes a client.
export const PEER_QUERY_PROTOCOL = 'peer-query/1';
export const PEER_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  responseBytes: 1024 * 1024,
  messageChars: 16_000,
  queuePerNode: 100,
  queryQueuePerNode: 20,
  queryQueuePerSender: 4,
  queryTtlSeconds: 60,
  queryReplyBytes: 48 * 1024,
  queryCount: 4,
  queryChars: 200,
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
export const TERMINAL_STATUSES = new Set(['answered', 'failed', 'cancelled', 'expired', 'unknown']);
export const RESULT_OUTCOMES = new Set(['answered', 'failed', 'cancelled', 'unknown', 'never_started']);
// Only "may still be running" crosses devices; nothing remote can confirm a release.
const CLEANUP_CODES = new Set(['cleanup_timeout', 'cleanup_failed']);

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

// A bounded copy of a woken process's unconfirmed cleanup, or null.
export function peerCleanup(value) {
  if (value?.status !== 'unconfirmed') return null;
  return { status: 'unconfirmed', code: CLEANUP_CODES.has(value.code) ? value.code : null };
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

// Text another device sent, as this computer shows it: without C0 and C1
// control characters (terminal escapes), bidirectional marks and overrides,
// zero-width and invisible filler characters, line and paragraph separators,
// or tag characters.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;
export function withoutControls(value) {
  return value.replace(CONTROLS, '');
}

const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });

// At most `limit` user-perceived characters: an emoji or an accented letter is never cut in two.
export function graphemePrefix(value, limit) {
  let text = '';
  let count = 0;
  for (const { segment } of GRAPHEMES.segment(value)) {
    if (count === limit) break;
    text += segment;
    count += 1;
  }
  return text;
}

export function shortFingerprint(fingerprint) {
  return fingerprint.slice(0, 24).toUpperCase().match(/.{4}/g).join(' ');
}

// peer/1 compatibility: keys, including integer-like keys, use lexical order.
// Publication JSON uses JavaScript integer-key order, so it cannot replace this
// wire encoding until a versioned peer protocol migration changes both ends.
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

// Message IDs are chosen by senders, so the coordinator keys them per sending
// device; a receiving device recomputes the key to tie a claim to its assertion.
export function peerMessageKey(senderNode, messageId) {
  return sha256Hex(`${senderNode}:${messageId}`);
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
  checkOriginAndLifetime(assertion, { now, maxSeconds: PEER_LIMITS.maxTtlSeconds, fail });
  return assertion;
}

const QUERY_FIELDS = ['protocol', 'messageId', 'from', 'to', 'query', 'issuedAt', 'expiresAt', 'origin'];
const QUERY_ACTIONS = new Set(['card', 'search']);
// Named by the plan for later slices; refused by name until they exist.
const LATER_QUERY_ACTIONS = new Set(['progress', 'request', 'request_status']);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

// A visitor's question: exactly these fields, no body, depth, conversation or
// chat wake, a lifetime of at most a minute, and its queries bounded here, so
// nothing larger reaches the coordinator's queue or the receiving device's search.
export function validateQuery(assertion, { now = Date.now() } = {}) {
  const fail = (message) => { throw new PeerError('invalid_query', message); };
  if (!assertion || typeof assertion !== 'object' || assertion.protocol !== PEER_QUERY_PROTOCOL) fail('Unsupported query protocol');
  if (!exactKeys(assertion, QUERY_FIELDS)) fail('A query carries exactly its protocol, identity, ends, question, times and origin');
  if (!isOpaqueId(assertion.messageId)) fail('Invalid query identity');
  const { from, to, query } = assertion;
  if (!exactKeys(from, ['node', 'agentId', 'name']) || !isFingerprint(from.node) || !isOpaqueId(from.agentId)
    || typeof from.name !== 'string' || from.name.length > 120) fail('Invalid sender');
  if (!exactKeys(to, ['node', 'bindingId', 'agentId']) || !isFingerprint(to.node) || !isOpaqueId(to.bindingId) || !isOpaqueId(to.agentId)) {
    fail('Invalid recipient');
  }
  if (from.node === to.node) fail('A device cannot query itself');
  if (LATER_QUERY_ACTIONS.has(query?.action)) throw new PeerError('query_action_unsupported', 'This device answers only card and search', 422);
  if (!QUERY_ACTIONS.has(query?.action)) fail('Unknown query action');
  if (query.action === 'card' && !exactKeys(query, ['action'])) fail('A card query carries no queries');
  if (query.action === 'search' && (!exactKeys(query, ['action', 'queries']) || !Array.isArray(query.queries)
    || query.queries.length < 1 || query.queries.length > PEER_LIMITS.queryCount
    || !query.queries.every((text) => typeof text === 'string' && text.trim() && text.length <= PEER_LIMITS.queryChars))) {
    fail(`A search carries 1 to ${PEER_LIMITS.queryCount} queries of at most ${PEER_LIMITS.queryChars} characters`);
  }
  checkOriginAndLifetime(assertion, { now, maxSeconds: PEER_LIMITS.queryTtlSeconds, fail });
  return assertion;
}

// The origin proof's outer shape and the signed lifetime, shared by messages and queries.
function checkOriginAndLifetime(assertion, { now, maxSeconds, fail }) {
  const origin = assertion.origin;
  if (!origin || typeof origin.payload !== 'string' || typeof origin.signature !== 'string'
    || origin.payload.length > 4096 || origin.signature.length > 128 || Object.keys(origin).length !== 2) {
    fail('A remote message needs its origin proof');
  }
  const issued = canonicalTime(assertion.issuedAt);
  const expires = canonicalTime(assertion.expiresAt);
  if (issued === null || expires === null) fail('Message times must be canonical UTC ISO timestamps');
  if (!(issued <= now + 60_000) || !(expires > issued) || expires - issued > maxSeconds * 1000) fail('Invalid message lifetime');
  if (expires <= now) throw new PeerError('message_expired', 'This message has expired', 410);
}

export function publicDirectoryEntry(entry) {
  if (!isOpaqueId(entry?.bindingId) || !isOpaqueId(entry?.agentId)) throw new PeerError('invalid_directory', 'Invalid shared Agent');
  const text = (value, max) => typeof value === 'string' ? graphemePrefix(withoutControls(value), max) : null;
  return { bindingId: entry.bindingId, agentId: entry.agentId, name: text(entry.name, 120) ?? entry.agentId,
    employeeNumber: text(entry.employeeNumber, 32), responsibility: text(entry.responsibility, 500),
    projectName: text(entry.projectName, 120),
    ...(entry.projectId !== undefined ? { projectId: text(entry.projectId, 128) } : {}),
    ...(entry.occupation !== undefined ? { occupation: text(entry.occupation, 120) } : {}),
    ...(entry.capabilities !== undefined ? { capabilities: (Array.isArray(entry.capabilities) ? entry.capabilities : [])
      .filter(c => typeof c === 'string').slice(0, 20).map(c => c.slice(0, 128)) } : {}),
    ...(entry.communicationOnly === true ? { communicationOnly: true } : {}),
    clients: (Array.isArray(entry.clients) ? entry.clients : []).filter((client) => isOpaqueId(client)).slice(0, 4) };
}
