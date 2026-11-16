import { detectClients } from '../agent-kits/client-detection.js';
import { CLIENT_COMPONENT_UNAVAILABLE } from '../agent-kits/client-installer.js';
import { installAgent } from '../setup/install-agent.js';
import { assertJsonObject } from '../validation/values.js';

// What the person reads when a client that writes its cached configuration back is (or may be) running.
export const CLIENT_RUNNING = '客户端正在运行，会把旧配置写回：先完全退出它，或在客户端接入里点「重启并更新」。'
  + ' The client is running and would write its old configuration back: quit it fully, or use Restart and update in Client connection.';

// The console's one-click connection: agent-installer writes a client it
// found on this machine that FULI may set up by itself, or one the person
// described by hand (custom-clients.js), whose file it creates when it is
// not there yet. Without
// agent-installer nothing is written and the answer says why. apps: the
// client apps that write their cached configuration back (src/agents/client-apps.js):
// one of them is written only when it is known to be closed (rec#106).
export function createClientInstaller({ installer, install = installAgent, apps = {} }) {
  let busy = false;
  return async (input) => {
    assertJsonObject(input, 'Client connection');
    if (Object.keys(input).length !== 1 || typeof input.clientId !== 'string') {
      throw new TypeError('Expected only a clientId');
    }
    if (busy) throw new TypeError('A client connection is already being installed');
    busy = true;
    try {
      const app = Object.hasOwn(apps, input.clientId) ? apps[input.clientId] : null;
      if (app && await app.running().catch(() => null) !== false) {
        return { id: input.clientId, status: 'failed', restartRequired: false, reason: 'client_running', message: CLIENT_RUNNING };
      }
      const detected = await detectClients(installer);
      const result = detected.status === 'available'
        ? await install(installer, connectable(detected.clients, input.clientId))
        : { status: 'failed', reason: 'client_component_unavailable', message: CLIENT_COMPONENT_UNAVAILABLE };
      // Do not expose config/backup paths or raw filesystem diagnostics over HTTP.
      return { id: input.clientId, status: result.status, restartRequired: result.status === 'connected',
        ...(result.reason ? { reason: result.reason, message: result.message } : {}) };
    } finally { busy = false; }
  };
}

function connectable(clients, clientId) {
  const client = clients.find(({ id }) => id === clientId);
  // A built-in client must be on this machine; the person said where a client of their own keeps its file.
  if (!client || client.manual || (client.builtin && !client.detected)) {
    throw new TypeError('Client is unavailable for automatic connection');
  }
  return { id: client.id, label: client.label };
}
