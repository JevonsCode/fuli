import { setTimeout as delay } from 'node:timers/promises';

import { assertJsonObject } from '../validation/values.js';

// How long the app has to finish its own quit (it may save open work first).
const QUIT_DEADLINE_MS = 30_000;
const QUIT_POLL_MS = 500;
// A reopened client reads its configuration, and may save it, as it starts.
const SETTLE_MS = 5_000;

/**
 * 「重启并更新」 (rec#106): quit a client app that writes its cached
 * configuration back, update FULI's entry while it is closed, reopen it, and
 * check the entry is still current. Reached only from the console on this
 * computer, never from an Agent: it ends the client's open sessions.
 *
 * apps: clientApps() (src/agents/client-apps.js). connect: the console's
 * one-click connection (client-connection-install.js). inspect(id): the
 * client as agent-installer finds it now (client-detection.js inspectAgent).
 *
 * Answers { id, status }: `connected`; `quit_failed` (still running, nothing
 * written); `connect_failed` (reopened as it was); `reopen_failed` (updated,
 * the person opens it); `check_failed` (reopened, but the entry is not current).
 */
export function createClientRestart({ apps, connect, inspect, wait = delay, now = Date.now }) {
  let busy = false;
  return async (input) => {
    assertJsonObject(input, 'Client restart');
    if (Object.keys(input).length !== 1 || typeof input.clientId !== 'string') throw new TypeError('Expected only a clientId');
    const app = Object.hasOwn(apps, input.clientId) ? apps[input.clientId] : null;
    if (!app) throw new TypeError('FULI cannot restart this client here');
    if (busy) throw new TypeError('A client restart is already running');
    busy = true;
    try { return { id: input.clientId, ...await restart(app, input.clientId) }; } finally { busy = false; }
  };

  async function restart(app, clientId) {
    // An app that cannot say whether it runs counts as running: nothing is written while it might be.
    const running = () => app.running().catch(() => true);
    if (await running()) {
      try { await app.quit(); } catch { return { status: 'quit_failed' }; }
      if (!await closed(running)) return { status: 'quit_failed' };
    }
    // The app is reopened whatever the write did.
    const written = await connect({ clientId }).catch(() => ({ status: 'failed' }));
    let reopened = true;
    try { await app.open(); } catch { reopened = false; }
    if (written.status !== 'connected') return { status: 'connect_failed', reopened, ...(written.reason ? { reason: written.reason } : {}) };
    if (!reopened) return { status: 'reopen_failed' };
    await wait(SETTLE_MS);
    return { status: (await inspect(clientId))?.integrationStatus === 'connected' ? 'connected' : 'check_failed' };
  }

  async function closed(running) {
    const deadline = now() + QUIT_DEADLINE_MS;
    while (now() < deadline) {
      await wait(QUIT_POLL_MS);
      if (!await running()) return true;
    }
    return false;
  }
}
