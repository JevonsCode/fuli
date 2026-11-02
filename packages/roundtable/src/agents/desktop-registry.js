import { createCodexDesktop } from './codex/desktop.js';

// Clients whose desktop app shows the person the conversation an ask is answered
// in. When one is installed, its asks go there instead of a headless wake.
const DESKTOP_APPS = Object.freeze({ codex: createCodexDesktop });

export function createDesktopApps(options = {}) {
  const apps = new Map(Object.entries(DESKTOP_APPS).map(([client, create]) => [client, create(options)]));
  return client => {
    const app = apps.get(client);
    return app?.available() ? app : null;
  };
}
