import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A task token says which FULI issued it (docs/runner-roles-design.md §4.4),
// so the calls and the checkpoint of a task go back to the computer that
// entered it, whatever the routes became meanwhile. A token the host issues
// reaches the client as ISSUED_PREFIX + the start of the host's fingerprint +
// '.' + the host's own token; this computer reads the issuer off it and sends
// the host its own token back, which the host alone checks. A token this
// computer gave out while the host was away (`runner-offline-…`) is this
// computer's by its own prefix.
//
// The prefix is not a credential: it only says where a call goes, and a call
// to a computer this one is not paired with is refused (routed-calls.js); the
// host still checks its own token.
const ISSUED_PREFIX = 'fuli-from-';
const ISSUER_LENGTH = 16;
const ISSUED = new RegExp(`^${ISSUED_PREFIX}([0-9a-f]{${ISSUER_LENGTH}})\\.(.+)$`);

// The host's token as the client gets it: with the host it came from.
export function issuedToken(hostFingerprint, token) {
  if (typeof token !== 'string' || !token || ISSUED.test(token) || typeof hostFingerprint !== 'string') return token;
  return `${ISSUED_PREFIX}${hostFingerprint.slice(0, ISSUER_LENGTH).toLowerCase()}.${token}`;
}

// { issuer, token } of a token that names its issuer, else null.
export function readIssued(token) {
  const match = typeof token === 'string' ? ISSUED.exec(token) : null;
  return match ? { issuer: match[1], token: match[2] } : null;
}

// A call's arguments with the token as its issuer wrote it, and the issuer.
// Through fuli_call the token is in the call's input.
export function withIssuedToken(name, args) {
  const nested = name === 'fuli_call' && typeof args?.toolName === 'string';
  const read = readIssued(nested ? args.input?.taskContextToken : args?.taskContextToken);
  if (!read) return { args, issuer: null };
  return { issuer: read.issuer, args: nested
    ? { ...args, input: { ...args.input, taskContextToken: read.token } }
    : { ...args, taskContextToken: read.token } };
}

// A task entry's answer with its token as the client is given it: naming the
// host that issued it, everywhere it appears (the token fields, and the calls
// the answer suggests for recovery, such as read_task_preferences'), in the
// text and in the structured answer alike, so the model never sees the token
// written two ways. Whatever form the host's answer takes (JSON, or JSON with
// a line after it), nothing else of it changes.
export function answerWithIssuer(result, hostFingerprint) {
  if (result?.isError || !hostFingerprint) return result;
  const raw = entryTokenIn(result);
  if (!raw || readIssued(raw)) return result;
  const issued = issuedToken(hostFingerprint, raw);
  const swap = (text) => text.split(raw).join(issued);
  return { ...result,
    content: (Array.isArray(result.content) ? result.content : [])
      .map((item) => (item?.type === 'text' && typeof item.text === 'string' ? { ...item, text: swap(item.text) } : item)),
    ...(result.structuredContent === undefined ? {}
      : { structuredContent: JSON.parse(swap(JSON.stringify(result.structuredContent))) }) };
}

// The task token a task entry was answered with, wherever the answer keeps it.
function entryTokenIn(result) {
  const structured = result?.structuredContent;
  const named = structured?.taskContextToken ?? structured?.task_context_token;
  if (typeof named === 'string' && named) return named;
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    const match = item?.type === 'text' ? /"(?:taskContextToken|task_context_token)"\s*:\s*"([^"\\]{1,200})"/.exec(item.text) : null;
    if (match) return match[1];
  }
  return null;
}

// On the FULI that issued it: a token the client was given with this FULI's
// own name (a conversation begun on a computer that follows this one, and
// continued here) is this FULI's own token; a token that names another FULI
// is that FULI's, and never taken here. issuer: the start of this
// installation's own fingerprint, or null where it has none. Answers
// { args } or { elsewhere } (the issuer the token names).
export function tokenIssuedHere(args, issuer) {
  const token = args?.taskContextToken;
  const read = readIssued(token);
  if (!read) return { args };
  if (issuer && read.issuer === issuer.slice(0, ISSUER_LENGTH).toLowerCase()) {
    return { args: { ...args, taskContextToken: read.token } };
  }
  return { elsewhere: read.issuer };
}

// The start of this installation's own fingerprint, read from its device
// certificate where it has one; never made here (only pairing makes one).
export function ownIssuer(dataDir, { read = (path) => readFileSync(path, 'utf8') } = {}) {
  // The SHA-256 of the certificate, as a pairing pins it (device-identity.js certificateFingerprint), read without
  // loading the peer modules into every MCP start.
  try {
    const digest = new X509Certificate(read(join(dataDir, 'peer', 'device-cert.pem'))).fingerprint256;
    return digest.replaceAll(':', '').toLowerCase().slice(0, ISSUER_LENGTH);
  } catch { return null; }
}
