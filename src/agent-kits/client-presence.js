import { createCliPresence } from './cli-presence.js';

// A built-in client's own command, for the clients that have one. agent-installer
// finds a client by FULI's own PATH and by the client's configuration files, so
// on a computer where a client is installed but has never written its
// configuration — a new computer, or a runner (rec#145) — it finds nothing and
// FULI never connects it. FULI adds no detection of its own beyond asking the
// person's login shell for these documented command names (cli-presence.js);
// everything that is then read or written still goes through agent-installer.
//
// `cursor-agent` is Cursor's own CLI, which an install can leave without the
// `cursor` shim the desktop app adds; `agy` is Antigravity's and `dsh` is
// DeepSeek Harness's, as docs/client-connections.md names them.
export const CLIENT_COMMANDS = Object.freeze({
  'claude-code': ['claude'],
  codex: ['codex'],
  cursor: ['cursor-agent', 'cursor'],
  opencode: ['opencode'],
  antigravity: ['agy'],
  dsh: ['dsh']
});

// Whether a built-in client is on this computer although agent-installer did
// not find it. One instance per process keeps cli-presence's answers (it starts
// the person's login shell to ask).
export function createClientPresence({ presence = createCliPresence(), commands = CLIENT_COMMANDS } = {}) {
  return {
    // The ids among `ids` whose own command is installed here, asked in parallel
    // so a status read waits for one shell, not one per client.
    async installed(ids) {
      const asked = ids.filter((id) => Object.hasOwn(commands, id));
      const found = await Promise.all(asked.map(async (id) => {
        const answers = await Promise.all(commands[id].map((command) => presence.find(command)));
        return answers.some(Boolean) ? id : null;
      }));
      return new Set(found.filter(Boolean));
    }
  };
}
