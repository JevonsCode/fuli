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
  hello: '/runner/1/hello',
  workspace: '/runner/1/workspace',
  mcp: '/runner/1/mcp',
  replay: '/runner/1/replay',
  // A prefix: the host's console paths follow it (console-relay.js).
  console: '/runner/1/console',
  // A runner client's prompt hook, entered on the host (hook-forwarding.js).
  hook: '/runner/1/hook'
});
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
export const ENTRY_ID = /^[A-Za-z0-9._:-]{1,200}$/;
// How long a runner waits for the host to answer one replayed entry before it
// gives up for this round; the host holds an id it is applying longer than this.
export const REPLAY_WAIT_MS = 3 * 60_000;
// The longest a runner waits for one MCP call (roundtable asks wait up to 15 minutes on the host).
export const CALL_TIMEOUT_MS = 16 * 60_000;
export const INVITATION_TTL_MS = 10 * 60 * 1000;
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
