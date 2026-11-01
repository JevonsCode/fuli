import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { appConflict, appNotFound } from './errors.js';

const TERMINAL_ACTIONS = new Set(['approve', 'rollback']);

// What the console's Apps section needs beyond the app port (#346 0.23),
// so that every step is a button (the console never sends the person to a
// terminal):
// - confirmInTerminal opens a terminal window running `fuli app approve|rollback`
//   for one stored version. The person types the app name there, so the
//   terminal confirmation flow and the run gate stay exactly as they are; the
//   answer means the window opened, not that anything was approved.
// - exportData copies the app's data into a new folder FULI picks under
//   exportsRoot, and revealExport shows such a folder in the file manager.
// cli is [node executable, FULI's cli.js]; openTerminal and reveal are the
// desktop adapters (src/desktop/terminal-window.js, reveal-path.js), and clock is a seam.
export function createAppConsoleActions({ agentApps, cli, runtimeConfigPath, exportsRoot, openTerminal, reveal,
  clock = () => new Date() }) {
  function confirmInTerminal({ appId, action, version }) {
    if (!TERMINAL_ACTIONS.has(action)) throw appConflict('invalid_action', 'Only approve and rollback are confirmed in a terminal');
    // The app id and version passed on are the stored ones, never the request's text.
    const app = agentApps.read({ appId });
    const stored = app.versions.find((candidate) => candidate.version === version);
    if (!stored) throw appNotFound('version_not_found', 'This app has no such version');
    return openTerminal([...cli, 'app', action, app.appId, stored.version, '--runtime-config', runtimeConfigPath]);
  }

  async function exportData({ appId }) {
    const stamp = clock().toISOString().replace(/[-:]|\.\d+/g, '');
    const destination = resolve(exportsRoot, `${appId}-${stamp}`);
    mkdirSync(exportsRoot, { recursive: true });
    const { files, bytes } = await agentApps.exportData({ appId, destination });
    return { path: destination, files, bytes };
  }

  // Only a folder exportData made for this app: a direct child of exportsRoot named for it.
  function revealExport({ appId, path }) {
    const folder = resolve(path);
    if (dirname(folder) !== resolve(exportsRoot) || !basename(folder).startsWith(`${appId}-`) || !existsSync(folder)) {
      throw appNotFound('export_not_found', 'No export of this app is there');
    }
    return reveal(folder);
  }

  return { confirmInTerminal, exportData, revealExport };
}
