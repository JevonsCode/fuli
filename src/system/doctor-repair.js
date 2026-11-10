import { reconnectableClients } from './doctor.js';

// The doctor's 「自动修复」 (POST /api/system/doctor/repair): only the items the
// doctor marks fix 'auto'. A client is reconnected through the console's own
// client installer, which backs up its configuration first. A data directory
// other accounts can open is limited to the person and SYSTEM. It never confirms
// a data format migration, never connects a client that was not connected
// before, and never restarts a client's sessions.
//
// Returns { results: [{ id, outcome: 'fixed' | 'failed' | 'skipped', error? }], doctor }
// with the doctor read again after the repair.

const NOT_RECONNECTED = 'The client could not be reconnected; connect it again in Settings → Clients.';
const NOT_RESTRICTED = 'Access to the data directory could not be limited to your account and SYSTEM.';

// check: the doctor's read (doctor.js). connectClient: the client installer
// (client-connection-install.js). recordClientsReconnected: marks the console
// update journal's clients reconnected (console-update.js). restrictDataDir:
// limits the data directory to its owner and SYSTEM (windows-data-acl.js).
export function createDoctorRepair({ check, connectClient, observeClients, recordClientsReconnected, restrictDataDir }) {
  let running = false;
  return async () => {
    if (running) throw new TypeError('A repair is already running. Please wait.');
    running = true;
    try {
      const before = await check();
      // One reconnection per client, however many items name it.
      const reconnections = new Map();
      const reconnect = (clientId) => {
        if (!reconnections.has(clientId)) reconnections.set(clientId, reconnectClient(connectClient, clientId));
        return reconnections.get(clientId);
      };
      const results = [];
      for (const item of before.items.filter(({ fix }) => fix === 'auto')) {
        if (item.kind === 'client_outdated') results.push({ id: item.id, ...await reconnect(item.data.clientId) });
        else if (item.kind === 'update_left_work') {
          results.push({ id: item.id, ...await finishUpdateReconnection(item, { reconnect, observeClients, recordClientsReconnected }) });
        } else if (item.kind === 'data_dir_shared') results.push({ id: item.id, ...await restrictDataDirectory(restrictDataDir) });
        else results.push({ id: item.id, outcome: 'skipped' });
      }
      return { results, doctor: await check() };
    } finally { running = false; }
  };
}

// What the update's own `setup --connected-only` would have done: reconnect
// every client whose FULI integration is still present.
async function finishUpdateReconnection(item, { reconnect, observeClients, recordClientsReconnected }) {
  const outcomes = [];
  for (const client of reconnectableClients((await observeClients()).clients)) outcomes.push(await reconnect(client.id));
  const failed = outcomes.find(({ outcome }) => outcome === 'failed');
  if (failed) return failed;
  recordClientsReconnected(item.data.updateId);
  return { outcome: 'fixed' };
}

// icacls' own text names the path and is localized, so it is not relayed.
async function restrictDataDirectory(restrictDataDir) {
  try {
    await restrictDataDir();
    return { outcome: 'fixed' };
  } catch { return { outcome: 'failed', error: NOT_RESTRICTED }; }
}

async function reconnectClient(connectClient, clientId) {
  try {
    const result = await connectClient({ clientId });
    if (result.status === 'connected') return { outcome: 'fixed' };
    // A running client that would write its old entry back is left to the person's 重启并更新 (rec#106).
    return result.reason === 'client_running' ? { outcome: 'skipped', error: result.message } : { outcome: 'failed', error: NOT_RECONNECTED };
  } catch (error) {
    // The installer's own refusals name no path; anything else may, so it is not relayed.
    return { outcome: 'failed', error: error instanceof TypeError ? error.message : NOT_RECONNECTED };
  }
}
