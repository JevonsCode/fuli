import { detectAgents, inspectAgent } from '../agent-kits/client-detection.js';
import { agentTargets } from '../setup/agents.js';
import { installAgent } from '../setup/install-agent.js';
import { integrationContext } from '../setup/integration-context.js';
import { assertJsonObject } from '../validation/values.js';

// The console's one-click connection: FULI's writer, for a client
// agent-installer found on this machine that FULI may write by itself.
export function createClientInstaller({ paths, runtimeConfigPath = paths.graphRuntimeConfigPath, installer,
  targets = () => agentTargets({ dataDir: paths.dataDir }), install = installAgent }) {
  let busy = false;
  return async (input) => {
    assertJsonObject(input, 'Client connection');
    if (Object.keys(input).length !== 1 || typeof input.clientId !== 'string') {
      throw new TypeError('Expected only a clientId');
    }
    if (busy) throw new TypeError('A client connection is already being installed');
    busy = true;
    try {
      const target = targets().find(({ id }) => id === input.clientId);
      const detected = target ? await detectAgents(installer, [target]) : null;
      const agent = detected?.agents?.[0];
      if (!agent?.available || agent.manualOnly) throw new TypeError('Client is unavailable for automatic connection');
      const result = await install(agent, { ...integrationContext(paths, runtimeConfigPath), defaultToolProfile: 'chat' },
        paths, { inspect: (connected) => inspectAgent(installer, connected) });
      // Do not expose config/backup paths or raw filesystem diagnostics over HTTP.
      return { id: agent.id, status: result.status, restartRequired: result.status === 'connected' };
    } finally { busy = false; }
  };
}
