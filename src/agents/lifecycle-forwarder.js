import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';

import { isProcessAlive } from '../local-runtime/processes.js';

// A thin lifecycle hook entry (rec#132 step 1): the hook process imports only
// Node built-ins, hands the call to the running FULI console of its data
// directory and prints its answer. Loading the whole hook took about half a
// second on every prompt; the console has it loaded. When the console cannot
// take the call, the hook runs it here exactly as before
// (lifecycle-events.js), so a computer where FULI is not running behaves as
// it always did. Before that decision the entry loads only this module, its
// hook contract and the process liveness check, which import nothing but Node
// built-ins (test/lifecycle-hook-forwarding.test.js).
//
// When the call runs here instead (the fallback), decided by whether the
// console may have received it:
// - before anything is sent: no --runtime-config, no running console recorded
//   for the data directory (graph-runtime-state.json, its PID alive, a
//   loopback http URL), stdin not closed within STDIN_WAIT_MS or larger than
//   FORWARDED_STDIN_LIMIT, a refused connection, or no connection within
//   CONNECT_BUDGET_MS → run here;
// - the console answered that it did not run the call (HOOK_OUTCOME_HEADER
//   "refused": another FULI version, another data directory, a malformed
//   call), or answered without that header (a console from before this
//   route) → run here;
// - once connected the call may have run: a connection lost after that, no
//   answer by the hook's own deadline plus ANSWER_GRACE_MS, or an answer that
//   says it ran but is malformed → never run again; the turn gets the hook's
//   unavailable answer (lostLifecycleEvent) and the failure is recorded.

// Hosts close stdin as soon as they wrote the payload; one that does not is
// left to the hook's own deadline, which the fallback keeps.
const STDIN_WAIT_MS = 500;
// Above the hook's own input limit (lifecycle-input.js, 256 KiB), so the
// console refuses an oversized payload with the hook's own answer.
const FORWARDED_STDIN_LIMIT = 512 * 1024;
// A loopback connection is made or refused in about a millisecond; this only
// bounds a console whose port is wedged before it accepted anything.
const CONNECT_BUDGET_MS = 300;
// The console answers by the hook's deadline (--timeout-ms) itself; this
// covers the hop back, and leaves the lost answer (which loads the hook) inside
// the host's own wait: Claude Code waits 30 s, the deadline is 28 s.
const ANSWER_GRACE_MS = 500;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

export const LIFECYCLE_HOOK_ROUTE = '/api/lifecycle-hooks/';
// Set by the console on every answer of that route: "ran" once it started the
// call, "refused" when it did not.
export const HOOK_OUTCOME_HEADER = 'x-fuli-lifecycle-hook';

const PACKAGE_JSON = new URL('../../package.json', import.meta.url);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

// The process entry: stdin in, the answer out, this process's exit code.
export async function runThinLifecycleHook({ client, envNames, timeoutMs }) {
  const startedAt = Date.now();
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  const env = namedEnvironment(process.env, envNames);
  const stdin = await readStdin(process.stdin, Math.min(STDIN_WAIT_MS, timeoutMs));
  const call = { client, argv, env, cwd, stdin: stdin.chunks };
  // forwardLifecycleEvent settles every failure after connecting itself; one
  // it throws happened before anything was sent.
  const forwarded = stdin.complete
    ? await forwardLifecycleEvent(call, { timeoutMs }).catch(() => ({ run: 'here', reason: 'forward_failed' }))
    : { run: 'here', reason: 'stdin' };
  let result;
  if (forwarded.run === 'there') result = forwarded.result;
  else {
    // Loaded only now: the whole hook, as before this entry was thin.
    const events = await import('./lifecycle-events.js');
    result = forwarded.run === 'here'
      ? await events.runLifecycleEvent({ ...call, stdin: stdin.complete ? stdin.chunks : stdin.rest() },
        { baseEnv: process.env })
      : await events.lostLifecycleEvent(call, forwarded.error, { baseEnv: process.env });
  }
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
  process.stdout.write(result.stdout, () => {
    // As before, the process ends by its deadline even if cancelled work
    // still holds it; finished work lets it end at once.
    setTimeout(() => process.exit(result.exitCode), Math.max(0, startedAt + timeoutMs - Date.now())).unref();
  });
}

// { run: 'there', result } | { run: 'here', reason } | { run: 'lost', error }
export async function forwardLifecycleEvent({ client, argv, env, cwd, stdin }, { timeoutMs, readText = readTextFile,
  isAlive = isProcessAlive, connectBudgetMs = CONNECT_BUDGET_MS } = {}) {
  const consoleUrl = recordedConsoleUrl(argv, cwd, { readText, isAlive });
  if (!consoleUrl) return { run: 'here', reason: 'no_console' };
  let version;
  try { version = JSON.parse(readText(PACKAGE_JSON)).version; } catch { return { run: 'here', reason: 'no_version' }; }
  const body = JSON.stringify({ version, argv, env, cwd, stdin: Buffer.concat(stdin).toString('base64') });
  return post(new URL(`${LIFECYCLE_HOOK_ROUTE}${client}`, consoleUrl), body,
    { connectBudgetMs, answerBudgetMs: timeoutMs + ANSWER_GRACE_MS });
}

function namedEnvironment(env, names) {
  return Object.fromEntries(names.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
}

// The hook's stdin as chunks: complete when it closed within STDIN_WAIT_MS
// and within FORWARDED_STDIN_LIMIT. Otherwise rest() replays what was read and
// then the rest of the stream for the hook run here.
function readStdin(stream, waitMs) {
  return new Promise(done => {
    const chunks = [];
    let size = 0;
    const finish = complete => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      if (!complete) stream.pause();
      done({ complete, chunks, rest: () => replay(chunks, stream) });
    };
    const onData = chunk => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > FORWARDED_STDIN_LIMIT) finish(false);
    };
    const onEnd = () => finish(true);
    // The hook run here meets the same error when it reads the rest.
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), waitMs);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

async function* replay(chunks, stream) {
  yield* chunks;
  if (!stream.readableEnded) yield* stream;
}

function recordedConsoleUrl(argv, cwd, { readText, isAlive }) {
  const flag = argv.indexOf('--runtime-config');
  const runtimeConfig = flag >= 0 ? argv[flag + 1] : null;
  if (typeof runtimeConfig !== 'string' || !runtimeConfig) return null;
  let state;
  try {
    state = JSON.parse(readText(join(dirname(resolve(cwd, runtimeConfig)), 'graph-runtime-state.json')));
  } catch { return null; }
  if (!Number.isSafeInteger(state?.pid) || state.pid < 1 || !isAlive(state.pid) || typeof state.url !== 'string') return null;
  try {
    const url = new URL(state.url);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password
      ? url.origin : null;
  } catch { return null; }
}

function post(url, body, { connectBudgetMs, answerBudgetMs }) {
  return new Promise(done => {
    let connected = false;
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(answerTimer);
      request.destroy();
      done(outcome);
    };
    const failed = error => finish(connected ? { run: 'lost', error } : { run: 'here', reason: 'unreachable' });
    const request = httpRequest(url, { method: 'POST', agent: false, headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close'
    } });
    const connectTimer = setTimeout(() => { if (!connected) finish({ run: 'here', reason: 'connect_timeout' }); },
      connectBudgetMs);
    const answerTimer = setTimeout(() => failed(lostError('lifecycle_forward_timeout')), answerBudgetMs);
    request.once('socket', socket => {
      const onConnect = () => { connected = true; };
      if (!socket.connecting) onConnect();
      else socket.once('connect', onConnect);
    });
    request.once('error', () => failed(lostError('lifecycle_forward_failed')));
    request.once('response', response => {
      const outcome = response.headers[HOOK_OUTCOME_HEADER];
      if (outcome !== 'ran') {
        finish({ run: 'here', reason: outcome === 'refused' ? 'refused' : 'no_route' });
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) failed(lostError('lifecycle_forward_answer_invalid'));
        else chunks.push(chunk);
      });
      response.once('error', () => failed(lostError('lifecycle_forward_failed')));
      response.once('end', () => {
        const result = response.statusCode === 200 ? hookResult(Buffer.concat(chunks)) : null;
        finish(result ? { run: 'there', result } : { run: 'lost', error: lostError('lifecycle_forward_answer_invalid') });
      });
    });
    request.end(body);
  });
}

function hookResult(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return typeof value?.stdout === 'string' && typeof value.stderr === 'string' && Number.isSafeInteger(value.exitCode)
      ? { stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode } : null;
  } catch { return null; }
}

function lostError(code) {
  return Object.assign(new Error('The console took the hook call and did not answer it'), { code });
}

function readTextFile(path) { return readFileSync(path, 'utf8'); }
