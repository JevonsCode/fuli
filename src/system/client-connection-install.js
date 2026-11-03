import { detectAgents } from '../agent-kits/client-detection.js';
import { CLIENT_COMPONENT_UNAVAILABLE } from '../agent-kits/client-installer.js';
import { installAgent } from '../setup/install-agent.js';
import { assertJsonObject } from '../validation/values.js';

// The console's one-click connection: agent-installer writes a client it
// found on this machine that FULI may set up by itself. Without
// agent-installer nothing is written and the answer says why.
export function createClientInstaller({ installer, install = installAgent }) {
  let busy = false;
  return async (input) => {
    assertJsonObject(input, 'Client connection');
    if (Object.keys(input).length !== 1 || typeof input.clientId !== 'string') {
      throw new TypeError('Expected only a clientId');
    }
    if (busy) throw new TypeError('A client connection is already being installed');
    busy = true;
    try {
      const detected = await detectAgents(installer);
      const result = detected.status === 'available'
        ? await install(installer, connectable(detected.agents, input.clientId))
        : { status: 'failed', reason: 'client_component_unavailable', message: CLIENT_COMPONENT_UNAVAILABLE };
      // Do not expose config/backup paths or raw filesystem diagnostics over HTTP.
      return { id: input.clientId, status: result.status, restartRequired: result.status === 'connected',
        ...(result.reason ? { reason: result.reason, message: result.message } : {}) };
    } finally { busy = false; }
  };
}

function connectable(agents, clientId) {
  const agent = agents.find(({ id }) => id === clientId);
  if (!agent?.available || agent.manualOnly) throw new TypeError('Client is unavailable for automatic connection');
  return agent;
}
