import { createCliPresence } from './cli-presence.js';

// A built-in client's own command, for the clients that have one. agent-installer
// finds a client by FULI's own PATH and by the client's configuration files, so
// on a computer where a client is installed but has never written its
// configuration — a new computer, or a runner (rec#145) — it finds nothing and
// FULI never connects it. FULI adds no detection of its own beyond asking the
// person's login shell for these documented command names (cli-presence.js);
// everything that is then read or written still goes through agent-installer.
//
// `cursor-agent` is Cursor's own CLI, which agent-installer 0.5.1 does not look
// for (it looks for the `cursor` shim the desktop app adds); `agy` is
// Antigravity's. DeepSeek Harness's `dsh` is left out on purpose: Linux has an
// unrelated "distributed shell" of that name, and agent-installer already finds
// DeepSeek Harness by its own folder.
export const CLIENT_COMMANDS = Object.freeze({
  'claude-code': ['claude'],
  codex: ['codex'],
  cursor: ['cursor-agent', 'cursor'],
  opencode: ['opencode'],
  antigravity: ['agy']
});

// Whether a built-in client is on this computer although agent-installer did
// not find it. Only a command this computer runs itself counts: on Windows a
// client that is only inside WSL ('wsl' from cli-presence.js) reads its
// configuration from the Linux home, so writing it under %USERPROFILE% would
// connect nothing. Such a client is reported apart, so the person is told
// to set it up inside WSL instead.
//
// Each probe starts the person's login shell (or wsl.exe, up to 15 seconds), so
// a page that only shows status never waits for one: it is answered from the
// last probe and starts the next in the background (wait: false), and the
// following read shows what it found. Setup and a connection wait for the
// answer, because they write. One instance per process shares the answers.
const UNANSWERED = Symbol('unanswered');

export function createClientPresence({ presence = createCliPresence(), commands = CLIENT_COMMANDS } = {}) {
  const known = new Map();
  const running = new Map();
  const probe = (command) => {
    if (!running.has(command)) {
      running.set(command, Promise.resolve(presence.find(command))
        .then((answer) => { known.set(command, answer); return answer; })
        .catch(() => null)
        .finally(() => running.delete(command)));
    }
    return running.get(command);
  };
  return {
    // { installed, inWsl, pending }: sets of ids among `ids`. wait: false answers
    // from the last probes only and refreshes them meanwhile; a client whose
    // command has never been answered yet is `pending`, not "not found".
    async find(ids, { wait = true } = {}) {
      const asked = ids.filter((id) => Object.hasOwn(commands, id));
      const answers = await Promise.all(asked.map(async (id) => [id, await Promise.all(commands[id].map((command) => {
        if (wait) return probe(command);
        void probe(command);
        return known.has(command) ? known.get(command) : UNANSWERED;
      }))]));
      const installed = new Set(answers.filter(([, found]) => found.includes('native')).map(([id]) => id));
      const inWsl = new Set(answers.filter(([id, found]) => !installed.has(id) && found.includes('wsl')).map(([id]) => id));
      const pending = new Set(answers.filter(([id, found]) => !installed.has(id) && !inWsl.has(id) && found.includes(UNANSWERED))
        .map(([id]) => id));
      return { installed, inWsl, pending };
    },
    // Resolves once the probes running now have answered (each is bounded by cli-presence's timeouts).
    settled: () => Promise.all([...running.values()]).then(() => undefined)
  };
}
