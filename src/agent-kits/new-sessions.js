import { InvalidInputError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';

// Opening a new session in a connected client's CLI, in a terminal window,
// with one prompt (rec#11 D-79; Jevons 11-08: every mainstream client). The
// console uses it where a client documents no prompt link
// (registry/client-links.json), through one shared helper
// (web/src/features/client-links/new-session.ts). The session launcher plans
// and opens; FULI only says which of its clients is which launcher client
// and whether that CLI is installed here.
//
// FULI's client IDs (agent-installer's, as 设置 › 客户端接入 lists them) and the
// launcher client that runs their CLI. Claude Desktop has no CLI of its own.
const TERMINAL_CLIENTS = Object.freeze({
  'claude-code': 'claude-code',
  codex: 'codex-cli',
  cursor: 'cursor-cli',
  opencode: 'opencode-cli',
  'gemini-cli': 'gemini-cli',
  antigravity: 'antigravity-cli',
  'qwen-code': 'qwen-code'
});
// The launcher's own limit (agent-session-launcher docs/protocol.md).
const MAX_PROMPT = 2000;

// launcher: the session launcher port (session-launcher.js).
// presence: createCliPresence() (cli-presence.js).
export function createNewSessions({ launcher, presence }) {
  // The CLI way of each FULI client, or null: the launcher must take a prompt
  // for it and open it on this platform, and its program must be installed.
  async function wayFor(clientId, launchable) {
    const client = TERMINAL_CLIENTS[clientId];
    if (!client || !launchable.has(client)) return null;
    const planned = await launcher.inspectNew({ client });
    if (planned.status !== 'available') return null;
    const found = await presence.find(planned.plan.executable);
    if (!found) return null;
    return { client, prompt: launchable.get(client), ...(found === 'wsl' ? { environment: 'wsl' } : {}) };
  }

  async function launchable() {
    const listed = await launcher.clients({ download: true });
    if (listed.status !== 'available') return { reason: listed.reason ?? listed.code };
    return { clients: new Map(listed.clients
      .filter((client) => client.enabled && client.newSession?.kind === 'cli' && client.newSession.openSupported
        && client.newSession.prompt)
      .map((client) => [client.id, client.newSession.prompt])) };
  }

  return {
    // For the console: { launcher: 'available', ways: { <clientId>: { prompt: 'send', environment? } } },
    // or { launcher: 'unavailable', reason }. Opens nothing.
    async ways(clientIds) {
      const known = clientIds.filter((id) => TERMINAL_CLIENTS[id]);
      const { clients, reason } = await launchable();
      if (!clients) return { launcher: 'unavailable', reason };
      const ways = {};
      for (const id of known) {
        const way = await wayFor(id, clients);
        if (way) ways[id] = { prompt: way.prompt, ...(way.environment ? { environment: way.environment } : {}) };
      }
      return { launcher: 'available', ways };
    },
    // The person clicked: open a new session of `client` with `prompt`.
    // Answers { status: 'launch_requested' } (the system accepted it, not that
    // the client started) or { status: 'unavailable' | 'refused', … }.
    async open({ client, prompt }) {
      const clientId = requiredString(client, 'client', 64);
      const text = requiredString(prompt, 'prompt', MAX_PROMPT);
      if (!TERMINAL_CLIENTS[clientId]) throw new InvalidInputError('client must be a connected client that runs in a terminal');
      const { clients, reason } = await launchable();
      if (!clients) return { status: 'unavailable', reason };
      const way = await wayFor(clientId, clients);
      if (!way) return { status: 'unavailable', reason: 'not_installed' };
      const opened = await launcher.openNew({ client: way.client, prompt: text,
        ...(way.environment ? { environment: way.environment } : {}) });
      if (opened.status === 'available') return { status: 'launch_requested' };
      return opened.status === 'refused' ? { status: 'refused', code: opened.code }
        : { status: 'unavailable', reason: opened.reason };
    }
  };
}
