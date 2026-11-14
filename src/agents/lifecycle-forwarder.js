import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';

import { checkLocalConsoleHealth } from '../local-runtime/console-health.js';
import { isProcessAlive } from '../local-runtime/processes.js';

// A thin lifecycle hook entry (rec#132 step 1): the hook process imports only
// Node built-ins, hands the call to the running FULI console of its data
// directory and prints its answer. Loading the whole hook took about half a
// second on every prompt; the console has it loaded. When the console cannot
// take the call, the hook runs it here exactly as before
// (lifecycle-events.js), so a computer where FULI is not running behaves as
// it always did. Before that decision the entry loads only this module, its
// hook contract, the process liveness check and the console health check,
// which import nothing but Node built-ins (test/lifecycle-hook-forwarding.test.js).
//
// When the call runs here instead (the fallback), decided by whether the
// console may have started it:
// - nothing sent: no --runtime-config; no running console recorded for the
//   data directory (graph-runtime-state.json, its PID alive, an http URL on
//   127.0.0.1 or [::1], the hosts the console's route accepts); its
//   /api/health not answering within HEALTH_BUDGET_MS as that PID's console of
//   this FULI version; stdin not closed within STDIN_WAIT_MS or larger than
//   FORWARDED_STDIN_LIMIT; less than MIN_CONSOLE_MS of the deadline left; no
//   connection within CONNECT_BUDGET_MS → run here;
// - sent but not started: the console answered HOOK_OUTCOME_HEADER "refused"
//   (another version or data directory, too many calls, this session's
//   earlier call still running past its deadline, an unsafe path), answered
//   without that header (a console from before this route, or one reached
//   past startBy), or sent no headers within HEADERS_BUDGET_MS (its
//   JavaScript is blocked: the kernel accepts connections anyway) → run here.
//   The console flushes "ran" in the same turn that starts the call, and only
//   while the connection is open and its hookClock() has not passed the
//   payload's startBy, START_MARGIN_MS before this side stops waiting; this
//   side decides only after reading what already arrived on its socket. A
//   double run needs both processes stalled for START_MARGIN_MS inside that
//   window (the console between its check and its write);
// - may have started: the connection made, then lost before "ran" arrived
//   (the console may have died or reset it after starting the call);
// - started ("ran" received): a connection lost after that, no answer by the
//   deadline less ANSWER_MARGIN_MS, or a malformed answer.
// The last two never run again: a second run repeats the event's writes
// without anyone seeing it (a prompt's turn gets a new id each run), a lost
// one is shown in that turn.
// The turn gets the hook's unavailable answer (lostLifecycleEvent) and the
// failure is recorded.

// Hosts close stdin as soon as they wrote the payload; one that does not is
// left to the hook's own deadline, which the fallback keeps.
const STDIN_WAIT_MS = 500;
// Above the hook's own input limit (lifecycle-input.js, 256 KiB), so the
// console refuses an oversized payload with the hook's own answer.
const FORWARDED_STDIN_LIMIT = 512 * 1024;
const HEALTH_BUDGET_MS = 300;
// A loopback connection is made or refused in about a millisecond; this only
// bounds a console whose port is wedged before it accepted anything.
const CONNECT_BUDGET_MS = 300;
const HEADERS_BUDGET_MS = 1500;
// The console starts the call only this long before this side stops waiting
// for its headers, which leaves their hop here inside the wait.
const START_MARGIN_MS = 500;
// The answer is due this long before the hook's deadline (measured from the
// hook's start), which leaves the lost answer (it loads the hook, ~0.6 s)
// inside the host's own wait: Claude Code waits 30 s, the deadline is 28 s.
const ANSWER_MARGIN_MS = 700;
// The console's own deadline ends this long before the answer is due, for the
// hop back; with less than MIN_CONSOLE_MS left the call is not forwarded.
const RETURN_MARGIN_MS = 250;
const MIN_CONSOLE_MS = 500;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

export const LIFECYCLE_HOOK_ROUTE = '/api/lifecycle-hooks/';
// Set by the console on every answer of that route: "ran" once it starts the
// call, "refused" when it did not.
export const HOOK_OUTCOME_HEADER = 'x-fuli-lifecycle-hook';

// Milliseconds on this computer's monotonic clock, which the hook process and
// the console read alike (unlike the wall clock, it never steps back).
export function hookClock() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

const PACKAGE_JSON = new URL('../../package.json', import.meta.url);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

// The process entry: stdin in, the answer out, this process's exit code.
export async function runThinLifecycleHook({ client, envNames, timeoutMs }) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeoutMs;
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  const env = namedEnvironment(process.env, envNames);
  const stdin = await readStdin(process.stdin, Math.min(STDIN_WAIT_MS, timeoutMs));
  const call = { client, argv, env, cwd, stdin: stdin.chunks };
  // forwardLifecycleEvent settles every failure after sending itself; one it
  // throws happened before anything was sent.
  const forwarded = stdin.complete
    ? await forwardLifecycleEvent(call, { deadlineAt }).catch(() => ({ run: 'here', reason: 'forward_failed' }))
    : { run: 'here', reason: 'stdin' };
  let result;
  if (forwarded.run === 'there') result = forwarded.result;
  else {
    // Loaded only now: the whole hook, as before this entry was thin. Its
    // deadline is what is left of this hook's.
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    const events = await import('./lifecycle-events.js');
    result = forwarded.run === 'here'
      ? await events.runLifecycleEvent({ ...call, stdin: stdin.complete ? stdin.chunks : stdin.rest(), timeoutMs: remainingMs },
        { baseEnv: process.env })
      : await events.lostLifecycleEvent(call, forwarded.error, { baseEnv: process.env });
  }
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
  process.stdout.write(result.stdout, () => {
    // As before, the process ends by its deadline even if cancelled work
    // still holds it; finished work lets it end at once.
    setTimeout(() => process.exit(result.exitCode), Math.max(0, deadlineAt - Date.now())).unref();
  });
}

// { run: 'there', result } | { run: 'here', reason } | { run: 'lost', error }
export async function forwardLifecycleEvent({ client, argv, env, cwd, stdin }, { deadlineAt, now = Date.now,
  readText = readTextFile, isAlive = isProcessAlive, healthy = checkLocalConsoleHealth,
  budgets: { health = HEALTH_BUDGET_MS, connect = CONNECT_BUDGET_MS, headers = HEADERS_BUDGET_MS } = {} } = {}) {
  const recorded = recordedConsole(argv, cwd, { readText, isAlive });
  if (!recorded) return { run: 'here', reason: 'no_console' };
  let version;
  try { version = JSON.parse(readText(PACKAGE_JSON)).version; } catch { return { run: 'here', reason: 'no_version' }; }
  // A reused PID and port could name a listener that is not this console.
  if (!(await healthy(recorded.url, recorded.pid, recorded.version, health, version))) {
    return { run: 'here', reason: 'not_this_console' };
  }
  const answerAt = deadlineAt - ANSWER_MARGIN_MS;
  const timeoutMs = answerAt - now() - RETURN_MARGIN_MS;
  if (timeoutMs < MIN_CONSOLE_MS) return { run: 'here', reason: 'no_time' };
  const answerMs = answerAt - now();
  const headersMs = Math.min(headers, answerMs);
  const startBy = hookClock() + headersMs - START_MARGIN_MS;
  const body = JSON.stringify({ version, argv, env, cwd, timeoutMs, startBy, stdin: Buffer.concat(stdin).toString('base64') });
  return post(new URL(`${LIFECYCLE_HOOK_ROUTE}${client}`, recorded.url), body, { connectMs: connect, headersMs, answerMs });
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

function recordedConsole(argv, cwd, { readText, isAlive }) {
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
      ? { url: url.origin, pid: state.pid, version: state.version } : null;
  } catch { return null; }
}

function post(url, body, { connectMs, headersMs, answerMs }) {
  return new Promise(done => {
    let connected = false;
    let started = false;
    let settled = false;
    const timers = [];
    const finish = outcome => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      request.destroy();
      done(outcome);
    };
    // Once connected the payload may have reached the console, which may have
    // started the call: a connection lost before "ran" is lost, not run here.
    const failed = error => finish(connected ? { run: 'lost', error } : { run: 'here', reason: 'unreachable' });
    // A due timer runs before this process reads its sockets: decide after
    // reading them, so "ran" already waiting on the socket counts.
    const afterReading = decide => setImmediate(() => { if (!settled) decide(); });
    const request = httpRequest(url, { method: 'POST', agent: false, headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close'
    } });
    timers.push(setTimeout(() => { if (!connected) finish({ run: 'here', reason: 'connect_timeout' }); }, connectMs),
      setTimeout(() => afterReading(() => { if (!started) finish({ run: 'here', reason: 'no_headers' }); }), headersMs),
      setTimeout(() => afterReading(() => finish(started ? { run: 'lost', error: lostError('lifecycle_forward_timeout') }
        : { run: 'here', reason: 'no_headers' })), answerMs));
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
      started = true;
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) failed(lostError('lifecycle_forward_answer_invalid'));
        else chunks.push(chunk);
      });
      response.once('error', () => failed(lostError('lifecycle_forward_failed')));
      response.once('aborted', () => failed(lostError('lifecycle_forward_failed')));
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
