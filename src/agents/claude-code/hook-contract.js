// What the installed Claude Code hook command line and its process carry that
// the hook's work depends on. Read by the thin hook entry, which may import
// nothing but Node built-ins (lifecycle-hook.js), and by the work it hands to
// the console (lifecycle-event.js), so this module imports nothing.

// The default is the installed command's own --timeout-ms (pack-manifest.js:
// Claude Code's 30 s hook timeout less 2 s).
const DEFAULT_TIMEOUT_MS = 28000;
const MAX_TIMER_MS = 2_147_483_647;

export function claudeHookTimeoutMs(args) {
  const configured = args.includes('--timeout-ms') ? Number(args[args.indexOf('--timeout-ms') + 1]) : DEFAULT_TIMEOUT_MS;
  return Number.isSafeInteger(configured) && configured > 0 && configured <= MAX_TIMER_MS ? configured : DEFAULT_TIMEOUT_MS;
}

// The environment variables the Claude hook's work reads that describe the
// calling session rather than the computer: how Claude Code was started, its
// configuration folder, a roundtable wake's delegation, the Provider timeout
// and test tools. A hook run by the console takes exactly these from the hook
// process (set or absent); everything else (PATH, home folders, credentials
// an external knowledge connector names) is the console's own environment.
export const CLAUDE_HOOK_ENV = Object.freeze([
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CONFIG_DIR',
  'FULI_PROVIDER_REQUEST_TIMEOUT_MS',
  'FULI_ROUNDTABLE_DELEGATION',
  'FULI_ROUNDTABLE_PEER_DEPTH',
  'FULI_ENABLE_TEST_TOOLS'
]);
