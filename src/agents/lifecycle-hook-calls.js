import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { recordHookFailure } from './lifecycle-failure.js';
import { parseHookInput } from './lifecycle-input.js';
import { lifecycleHookClient, runLifecycleEvent } from './lifecycle-events.js';

// The console's side of forwarded hook calls (lifecycle-hooks-api-router.js):
// which calls it takes, and the calls it is running. A call it does not take
// is refused before it runs, so the hook runs it in its own process as it did
// before forwarding existed.
//
// Taken only when:
// - fewer than MAX_CALLS calls run at once (a prompt's call takes about 0.1 s
//   here; 8 is far above what one person's sessions start together);
// - no earlier call of the same client session is still running past its
//   deadline (its stores and transcript guard may still be held; a hook
//   process would have been ended by then);
// - the payload's transcript_path is absent, missing or a regular file and
//   its cwd absent, missing or a directory, checked asynchronously within
//   PATH_CHECK_MS: the work opens and reads them synchronously, and a FIFO or
//   an unreachable share would freeze the console instead of one hook process.
//
// A call past its deadline (plus OVERDUE_GRACE_MS) is recorded in the
// diagnostics log. At its deadline the work was cancelled and its graph lease
// (with its heartbeat) and stores closed (lifecycle-event.js); what a call
// that still never settles keeps is its session's transcript guard, until it
// settles or the console restarts, and its session's later calls run in their
// own processes meanwhile.
const MAX_CALLS = 8;
const PATH_CHECK_MS = 200;
const OVERDUE_GRACE_MS = 1000;

export function createLifecycleHookCalls({ runtimeConfigPath, baseEnv, maxCalls = MAX_CALLS, now = Date.now,
  run = runLifecycleEvent, record = recordHookFailure }) {
  const running = new Set();
  return {
    runtimeConfigPath,
    // { refused: reason } or { start(): Promise<result> }. Synchronous after
    // the path check, so the router can confirm its socket and send its
    // headers in the same turn as start().
    async admit(call) {
      const input = hookInput(call.stdin);
      if (!(await pathsSafe(input))) return { refused: 'unsafe_path' };
      if (running.size >= maxCalls) return { refused: 'busy' };
      const session = typeof input?.session_id === 'string' ? `${call.client}\0${input.session_id}` : null;
      if (session && [...running].some(entry => entry.session === session && entry.overdue)) {
        return { refused: 'session_overdue' };
      }
      return { start: () => start(call, session, input) };
    },
    running: () => running.size
  };

  function start(call, session, input) {
    const startedAt = now();
    const entry = { session, overdue: false };
    running.add(entry);
    const settle = () => {
      clearTimeout(overdue);
      running.delete(entry);
    };
    const overdue = setTimeout(() => {
      entry.overdue = true;
      const client = lifecycleHookClient(call.client);
      record({ runtimeConfigPath, client: client.sourceApplication, event: eventOf(call.argv),
        error: Object.assign(new Error('A forwarded hook call is still running past its deadline'),
          { code: 'lifecycle_call_overdue' }), sessionId: input?.session_id ?? null, startedAt, now });
    }, call.timeoutMs + OVERDUE_GRACE_MS);
    overdue.unref?.();
    return run(call, { baseEnv, onSettled: settle }).catch(error => { settle(); throw error; });
  }
}

function hookInput(stdin) {
  try { return parseHookInput(Buffer.concat(stdin)); } catch { return null; }
}

function eventOf(argv) {
  return argv[argv.indexOf('--event') + 1];
}

async function pathsSafe(input) {
  const checks = [[input?.transcript_path, info => info.isFile()], [input?.cwd, info => info.isDirectory()]]
    .filter(([path]) => typeof path === 'string' && path);
  const results = await Promise.race([
    Promise.all(checks.map(([path, expected]) => stat(path).then(expected,
      error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR'))),
    delay(PATH_CHECK_MS, null, { ref: false })
  ]);
  return Array.isArray(results) && results.every(Boolean);
}
