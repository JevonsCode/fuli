import { presenceKindFor, presenceRefused } from './platforms.js';
import { windowsHelloPresence } from './windows-hello.js';

// The presence port: verify({ challengeId, message }) asks the OS to verify the
// current user and reports verified or a refusal; kind names the check
// (PRESENCE_LEVELS) or is null where the platform has none. Only the CLI's
// confirmed decisions use it, when `--hello` asks for it on top of the terminal
// confirmation; the console and Agent tools never reach it.
// A later platform plugs in here (D-28.1).
export function presencePort({ platform = process.platform, windows = {} } = {}) {
  if (presenceKindFor(platform) === 'hello') return windowsHelloPresence(windows);
  return {
    kind: null,
    verify: async () => presenceRefused('presence_unsupported_platform', platform)
  };
}
