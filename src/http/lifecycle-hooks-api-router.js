import { isAbsolute, resolve } from 'node:path';

import { isLocalOwnerRequest } from '../../packages/roundtable/src/peer/control.js';
import { DELEGATION_HEADER } from '../agent-delegation/delegation-header.js';
import { HOOK_OUTCOME_HEADER, LIFECYCLE_HOOK_ROUTE, hookClock } from '../agents/lifecycle-forwarder.js';
import { lifecycleHookClient } from '../agents/lifecycle-events.js';
import { FULI_VERSION } from '../package-metadata.js';
import { JsonBodyTooLargeError, readJson, sendJson } from './response.js';

// POST /api/lifecycle-hooks/<client>: a thin installed hook entry hands its
// call to the console (lifecycle-forwarder.js), which runs it as the hook
// process would (lifecycle-events.js) and answers its stdout, stderr and exit
// code.
//
// Trust boundary: the hook command is already runnable by any process of
// this computer's user, with any stdin, environment and working directory,
// against this data directory. This route takes exactly that and nothing
// more: only from this computer's loopback address with a loopback Host, never
// from a page (no Origin) or an FLA's delegated call, only this console's own
// data directory and FULI version, only the client's named hook variables,
// and the same work and limits the hook process has. It is never an Agent
// interface (interface-catalog.js lists it local_user_only).
//
// Every answer carries HOOK_OUTCOME_HEADER: "refused" before the call ran, so
// the hook runs it itself; "ran" once it starts, so it never runs twice. A
// call that runs gets its headers (with "ran") flushed in the same turn that
// starts it, after confirming the hook's connection is still open and the
// hook's startBy (hookClock) has not passed: a hook that saw no headers by
// then runs the call itself (lifecycle-forwarder.js). Which calls are taken:
// lifecycle-hook-calls.js.
const ROUTE = new RegExp(`^${LIFECYCLE_HOOK_ROUTE}([a-z][a-z0-9-]{0,63})$`);
// The forwarder sends at most 512 KiB of stdin, base64 in JSON.
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ARGS = 32;
const MAX_TEXT = 4096;
// What is left of the hook's own deadline; no client's hook waits longer.
const MAX_TIMEOUT_MS = 60_000;

export async function handleLifecycleHookRequest({ request, response, url, lifecycleHooks }) {
  const route = ROUTE.exec(url.pathname);
  if (!route) return false;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(HOOK_OUTCOME_HEADER, 'refused');
  if (!isLocalOwnerRequest(request) || request.headers.origin !== undefined
    || request.headers[DELEGATION_HEADER] !== undefined) {
    sendJson(response, 403, { error: 'Lifecycle hooks run only for this computer\'s own hook processes', code: 'local_user_only' });
    return true;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  const client = lifecycleHookClient(route[1]);
  if (!lifecycleHooks || !client) {
    sendJson(response, 404, { error: 'This console does not run this client\'s hooks', code: 'lifecycle_hook_unavailable' });
    return true;
  }
  let body;
  try {
    body = await readJson(request, { maxBytes: MAX_BODY_BYTES });
  } catch (error) {
    sendJson(response, error instanceof JsonBodyTooLargeError ? 413 : 400, { error: 'Invalid hook call', code: 'invalid_input' });
    return true;
  }
  const call = hookCall(body, client.envNames);
  if (!call) {
    sendJson(response, 400, { error: 'Invalid hook call', code: 'invalid_input' });
    return true;
  }
  // A hook of another FULI version runs its own code; one of another data
  // directory belongs to another console.
  if (body.version !== FULI_VERSION || !sameFile(runtimeConfigOf(call), lifecycleHooks.runtimeConfigPath)) {
    sendJson(response, 409, { error: 'This hook belongs to another FULI version or data directory', code: 'lifecycle_hook_mismatch' });
    return true;
  }
  const admitted = await lifecycleHooks.admit({ client: route[1], ...call });
  if (admitted.refused) {
    sendJson(response, 503, { error: 'The console does not take this hook call now', code: admitted.refused });
    return true;
  }
  // The hook gave up waiting and closed the connection: it runs the call itself.
  if (request.socket.destroyed || !request.socket.writable) {
    admitted.release();
    return true;
  }
  // Past startBy the hook may have given up without its close arriving yet.
  if (hookClock() > call.startBy) {
    admitted.release();
    sendJson(response, 503, { error: 'The hook stopped waiting for this call', code: 'late' });
    return true;
  }
  response.setHeader(HOOK_OUTCOME_HEADER, 'ran');
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.flushHeaders();
  let result;
  try {
    result = await admitted.start();
  } catch (error) {
    // The headers already said "ran": the hook answers this turn as lost.
    response.destroy();
    throw error;
  }
  response.end(JSON.stringify(result));
  return true;
}

function hookCall(body, envNames) {
  const { argv, env, cwd, stdin, timeoutMs, startBy } = body ?? {};
  const text = value => typeof value === 'string' && value.length <= MAX_TEXT;
  if (!Array.isArray(argv) || argv.length > MAX_ARGS || !argv.every(text)) return null;
  if (!text(cwd) || !isAbsolute(cwd) || typeof stdin !== 'string') return null;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) return null;
  if (!Number.isSafeInteger(startBy)) return null;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  if (!Object.entries(env).every(([name, value]) => envNames.includes(name) && text(value))) return null;
  return { argv, env, cwd, timeoutMs, startBy, stdin: [Buffer.from(stdin, 'base64')] };
}

function runtimeConfigOf({ argv, cwd }) {
  const flag = argv.indexOf('--runtime-config');
  return flag >= 0 && typeof argv[flag + 1] === 'string' ? resolve(cwd, argv[flag + 1]) : null;
}

function sameFile(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const fold = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return fold(left) === fold(right);
}
