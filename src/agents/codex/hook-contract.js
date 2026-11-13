// What the installed Codex hook command line and its process carry that the
// hook's work depends on. Read by the thin hook entry, which may import
// nothing but Node built-ins (lifecycle-hook.js), and by the work it hands to
// the console (lifecycle-event.js), so this module imports nothing.

// Task entry gets longer: a warm entry already takes 2–4 s on a Mac and a cold
// first one ran past 5 s, which costs the model two fallback requests. Both
// stay well inside the host's 30 s hook timeout.
const ENTRY_TIMEOUT_MS = 15_000;
const OTHER_TIMEOUT_MS = 5_000;

export function codexHookTimeoutMs(args) {
  const event = args[args.indexOf('--event') + 1];
  const limit = event === 'UserPromptSubmit' ? ENTRY_TIMEOUT_MS : OTHER_TIMEOUT_MS;
  const configured = Number(args[args.indexOf('--timeout-ms') + 1]);
  return args.includes('--timeout-ms') && Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, limit) : limit;
}

// The environment variables the Codex hook's work reads that describe the
// calling session rather than the computer: Codex's home folder (its session
// files and token usage), a roundtable wake's delegation, the Provider timeout
// and test tools. A hook run by the console takes exactly these from the hook
// process (set or absent); everything else is the console's own environment.
export const CODEX_HOOK_ENV = Object.freeze([
  'CODEX_HOME',
  'FULI_PROVIDER_REQUEST_TIMEOUT_MS',
  'FULI_ROUNDTABLE_DELEGATION',
  'FULI_ROUNDTABLE_PEER_DEPTH',
  'FULI_ENABLE_TEST_TOOLS'
]);
