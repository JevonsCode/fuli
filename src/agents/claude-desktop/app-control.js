import { execute } from '../../local-runtime/windows-process-handle.js';

// Claude Desktop on macOS, asked through its bundle id (rec#106). It keeps its
// configuration in memory and writes it back when it saves settings or quits,
// so FULI updates its MCP entry only while it is not running. Quitting is
// the app's own quit, never a kill: an app that refuses stays open.
const BUNDLE_ID = 'com.anthropic.claudefordesktop';
const APPLESCRIPT_TIMEOUT_MS = 10_000;

// run(command, args, options) → { stdout }: execute() in production, a fake in tests.
// Answers null where FULI cannot quit and reopen it.
export function claudeDesktopApp({ platform = process.platform, run = execute } = {}) {
  if (platform !== 'darwin') return null;
  const script = (line) => run('osascript', ['-e', line], { timeout: APPLESCRIPT_TIMEOUT_MS });
  return {
    // `is running` never launches the app.
    running: async () => (await script(`application id "${BUNDLE_ID}" is running`)).stdout.trim() === 'true',
    quit: () => script(`tell application id "${BUNDLE_ID}" to quit`),
    open: () => run('open', ['-b', BUNDLE_ID], { timeout: APPLESCRIPT_TIMEOUT_MS })
  };
}
