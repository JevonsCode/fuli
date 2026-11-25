import { randomBytes, X509Certificate } from 'node:crypto';
import { isIPv4 } from 'node:net';

import { InvalidInputError } from '../app/application-error.js';
import { certificateFingerprint } from '../../packages/roundtable/src/peer/device-identity.js';
import { sha256Bytes } from '../security/digest.js';
import { withoutControls } from '../text/control-characters.js';

// What a host and its runners (docs/runner.md) agree on: the port, the paths,
// the mDNS service, and the one-use invitation a runner joins with.
export const RUNNER_PORT = 2730;
export const RUNNER_SERVICE_TYPE = 'fuli-runner';
export const RUNNER_PATHS = Object.freeze({
  pair: '/runner/1/pair',
  projectReservation: '/runner/1/project-reservation',
  hello: '/runner/1/hello',
  workspace: '/runner/1/workspace',
  mcp: '/runner/1/mcp',
  replay: '/runner/1/replay',
  // A prefix: the host's console paths follow it (console-relay.js).
  console: '/runner/1/console',
  // A runner client's prompt hook, entered on the host (hook-forwarding.js).
  hook: '/runner/1/hook',
  // One scope the host owns, for a follower's read-only copy (host-scope-export.js):
  // `?scope=global&part=digest` its digest and versions, `part=envelope` the export as the Provider wrote it.
  scope: '/runner/1/scope'
});
// The largest scope envelope a host hands on and a follower takes: an import holds the whole space
// and the envelope in the Provider's memory at once (docs/runner-roles-design.md §12). Past it the
// host answers 413 `scope_too_large`, never a cut envelope.
export const SCOPE_ENVELOPE_MAX_BYTES = 64 * 1024 * 1024;
// The digest of the envelope a host's answer carries, beside its raw bytes.
export const SCOPE_DIGEST_HEADER = 'x-fuli-scope-digest';
// The client a runner's MCP session serves, named by its process (never a tool argument).
export const SOURCE_APPLICATION_HEADER = 'x-fuli-source-application';
// The client session that process serves, as a local client's MCP process names it.
export const RUNNER_SESSION_HEADER = 'x-fuli-runner-session';
// '1' when that session is the client's own, read from the environment the client gave the runner's MCP process.
export const NATIVE_SESSION_HEADER = 'x-fuli-runner-native-session';
// The tool profile the client's FULI entry names (chat unless it asks for full).
export const TOOL_PROFILE_HEADER = 'x-fuli-tool-profile';
// A runner's console entry sets it when the browser sent an Origin the entry checked was its own (console-relay.js).
export const SAME_ORIGIN_HEADER = 'x-fuli-runner-same-origin';
// The id a runner gives each checkpoint, online in the call's _meta and the
// same id in its outbox when that call's outcome is unknown; the host applies
// one id once (host-store.js claimReplay).
export const RUNNER_ENTRY_META = 'fuli/runner-entry';
// An outbox entry of a follower's writes to global, which its host owns and
// applies op by op (host-global-writes.js). A host that applies it says
// `globalWrites: 1` in its hello; an older one refuses the entry as invalid.
export const GLOBAL_WRITES_ENTRY = 'global_writes';
export const ENTRY_ID = /^[A-Za-z0-9._:-]{1,200}$/;
// A replayed entry may be as large as the MCP request it stands for (a
// checkpoint, mcp/http-session-transport.js): a smaller bound on the host refused
// the larger ones for good, and what they carried was lost. A follower measures
// an entry of its writes to global against it before queueing (global-writes-outbox.js).
export const REPLAY_MAX_BYTES = 1024 * 1024;
// How long a runner waits for the host to answer one replayed entry before it
// gives up for this round; the host holds an id it is applying longer than this.
export const REPLAY_WAIT_MS = 3 * 60_000;
// The longest a runner waits for one MCP call (roundtable asks wait up to 15 minutes on the host).
export const CALL_TIMEOUT_MS = 16 * 60_000;
export const INVITATION_TTL_MS = 10 * 60 * 1000;
// How a host of this version begins its refusal at the MCP session limit, which
// already says whose sessions are open and what to do (host-routes.js); a
// runner adds a next step of its own to any other refusal (offline-calls.js).
export const SESSION_LIMIT_REASON = 'Runner MCP session limit: ';
const INVITATION_PREFIX = 'fuli-runner-invite:1:';
const MAX_NAME = 64;
const MAX_ADDRESSES = 8;

// One line for the MCP sessions a runner holds on its host, from the host's hello (host-routes.js).
export function mcpSessionsLine({ owned, open, max }) {
  return `MCP sessions on the host: ${owned} of this computer, ${open} of ${max} in all.`;
}

export function newInvitationCode() {
  return randomBytes(24).toString('base64url');
}

export function invitationCodeHash(code) {
  return sha256Bytes(Buffer.from(String(code)));
}

export function encodeInvitation({ name, addresses, port, certPem, code }) {
  return `${INVITATION_PREFIX}${Buffer.from(JSON.stringify({ name, addresses, port, certPem, code })).toString('base64url')}`;
}

// The invitation a person copied from the host, checked once here.
export function parseInvitation(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  let body;
  try {
    if (!value.startsWith(INVITATION_PREFIX)) throw new Error('prefix');
    body = JSON.parse(Buffer.from(value.slice(INVITATION_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new InvalidInputError('invitation is not a FULI runner invitation; copy the whole line `fuli runner invite` printed');
  }
  const addresses = Array.isArray(body?.addresses) ? body.addresses.filter((address) => isIPv4(address)) : [];
  if (!addresses.length || addresses.length > MAX_ADDRESSES || !Number.isInteger(body.port)
    || body.port < 1 || body.port > 65535 || typeof body.code !== 'string' || body.code.length < 16
    || typeof body.certPem !== 'string') {
    throw new InvalidInputError('invitation is incomplete; copy the whole line `fuli runner invite` printed');
  }
  try { new X509Certificate(body.certPem); } catch {
    throw new InvalidInputError('invitation names no valid host certificate');
  }
  return { name: displayName(body.name, 'FULI host'), addresses, port: body.port, certPem: body.certPem,
    fingerprint: certificateFingerprint(body.certPem), code: body.code };
}

// A name people chose for a computer, kept short and on one line.
export function displayName(value, fallback) {
  const name = typeof value === 'string' ? withoutControls(value) : '';
  return name ? [...name].slice(0, MAX_NAME).join('') : fallback;
}
