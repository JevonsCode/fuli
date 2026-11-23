import { execFile } from 'node:child_process';

import { createCliPresence } from './cli-presence.js';

// A built-in client's own command, for the clients that have one. agent-installer
// finds a client by FULI's own PATH and by the client's configuration files, so
// on a computer where a client is installed but has never written its
// configuration — a new computer, or a runner (rec#145) — it finds nothing and
// FULI never connects it. FULI adds no detection of its own beyond asking the
// person's login shell for these documented command names (cli-presence.js);
// everything that is then read or written still goes through agent-installer.
//
// A name alone is not proof: an alias or shell function of that name, a shim
// an uninstall left behind, or another product with the same name (the archived
// Go `opencode` reads a different configuration) would get a configuration
// written for nothing. So the program must be an executable file and answer
// `args` with the client's own mark (`signature`), as these versions do:
//   claude --version        → "2.1.280 (Claude Code)"
//   codex --version         → "codex-cli 0.166.0"
//   cursor-agent --help     → "… Start the Cursor Agent …"
//   cursor --version        → version, 40-character commit, architecture (the desktop app's shim)
//   opencode --help         → lists "opencode mcp" (sst/opencode; the Go one has no such command)
// `cursor-agent` is Cursor's own CLI, which agent-installer 0.5.1 does not look
// for. Antigravity (`agy`) and DeepSeek Harness (`dsh`, a name Linux's
// distributed shell shares) are left to agent-installer, which finds both by
// their own folders: FULI has no verified mark for either.
export const CLIENT_COMMANDS = Object.freeze({
  'claude-code': [{ program: 'claude', args: ['--version'], signature: /\(Claude Code\)/ }],
  codex: [{ program: 'codex', args: ['--version'], signature: /^codex-cli \d/m }],
  cursor: [
    { program: 'cursor-agent', args: ['--help'], signature: /\bCursor Agent\b/ },
    { program: 'cursor', args: ['--version'], signature: /^\d+\.\d+\.\d+\s*\r?\n[0-9a-f]{40}\s*\r?\n/ }
  ],
  opencode: [{ program: 'opencode', args: ['--help'], signature: /\bopencode mcp\b/ }]
});
// A CLI answers --version or --help at once; one that does not is not counted.
const ANSWER_MS = 5000;

const UNANSWERED = Symbol('unanswered');

// Whether a built-in client is on this computer although agent-installer did
// not find it. Only a command this computer runs itself counts: on Windows a
// client that is only inside WSL ('wsl' from cli-presence.js) reads its
// configuration from the Linux home, so writing it under %USERPROFILE% would
// connect nothing. Such a client is reported apart, so the person is told
// to set it up inside WSL instead (its mark is not checked there: it is never written).
//
// Each probe starts the person's login shell (or wsl.exe, up to 15 seconds), so
// a page that only shows status never waits for one: it is answered from the
// last probe and starts the next in the background (wait: false), and the
// following read shows what it found. Setup and a connection wait for the
// answer, because they write. One instance per process shares the answers.
// presence: cli-presence.js (find, locate). answer(path, args): the program's output, or null.
export function createClientPresence({ presence = createCliPresence(), commands = CLIENT_COMMANDS, answer = answerOf } = {}) {
  const known = new Map();
  const running = new Map();
  const byProgram = new Map(Object.values(commands).flat().map((entry) => [entry.program, entry]));

  // 'native' only for a program that is an executable file answering with its client's mark.
  async function check(program) {
    const found = await presence.find(program);
    if (found !== 'native') return found;
    const entry = byProgram.get(program);
    const path = presence.locate ? await presence.locate(program) : null;
    if (!entry || !path) return null;
    const said = await answer(path, entry.args);
    return typeof said === 'string' && entry.signature.test(said) ? 'native' : null;
  }
  const probe = (program) => {
    if (!running.has(program)) {
      running.set(program, Promise.resolve(check(program))
        .then((found) => { known.set(program, found); return found; })
        .catch(() => null)
        .finally(() => running.delete(program)));
    }
    return running.get(program);
  };
  return {
    // { installed, inWsl, pending }: sets of ids among `ids`. wait: false answers
    // from the last probes only and refreshes them meanwhile; a client whose
    // command has never been answered yet is `pending`, not "not found".
    async find(ids, { wait = true } = {}) {
      const asked = ids.filter((id) => Object.hasOwn(commands, id));
      const answers = await Promise.all(asked.map(async (id) => [id, await Promise.all(commands[id].map(({ program }) => {
        if (wait) return probe(program);
        void probe(program);
        return known.has(program) ? known.get(program) : UNANSWERED;
      }))]));
      const installed = new Set(answers.filter(([, found]) => found.includes('native')).map(([id]) => id));
      const inWsl = new Set(answers.filter(([id, found]) => !installed.has(id) && found.includes('wsl')).map(([id]) => id));
      const pending = new Set(answers.filter(([id, found]) => !installed.has(id) && !inWsl.has(id) && found.includes(UNANSWERED))
        .map(([id]) => id));
      return { installed, inWsl, pending };
    },
    // One program as the last probe found it ('native' | 'wsl' | null), probing it
    // again meanwhile; null too while it has never been answered.
    async command(program) {
      void probe(program);
      return known.get(program) ?? null;
    },
    // Resolves once the probes running now have answered (each is bounded).
    settled: () => Promise.all([...running.values()]).then(() => undefined)
  };
}

// What the program prints for `args` within ANSWER_MS, or null; never rejects.
function answerOf(path, args) {
  return new Promise((resolve) => {
    execFile(path, args, { timeout: ANSWER_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => resolve(error && !stdout ? null : `${stdout ?? ''}\n${stderr ?? ''}`));
  });
}
