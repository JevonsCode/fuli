import { join } from 'node:path';

import { inspectAgent } from '../agent-kits/client-detection.js';
import { customClientStore } from '../agent-kits/custom-clients.js';
import { agentKitPorts } from '../agent-kits/ports.js';
import { clientApps } from '../agents/client-apps.js';
import { sessionsAwaitingRestart } from '../mcp/process-registry.js';
import { FULI_VERSION } from '../package-metadata.js';
import { clientConnectionConfig } from '../setup/client-connection.js';
import { createClientConnectionObserver } from '../system/client-connection-status.js';
import { createClientInstaller } from '../system/client-connection-install.js';
import { createClientRestart } from '../system/client-restart.js';
import { createCustomClients } from '../system/custom-client-connection.js';

// The clients on a runner (docs/runner.md), for its console's 客户端接入:
// detected, connected and added here, with the same entries `fuli runner join`
// and `fuli setup` write on a runner, so the runner's page lists this
// computer's Codex, Cursor and the rest instead of the host's. The same parts
// as the console's system service, without anything of a graph runtime.
// paths: resolveSetupPaths() for the runner's data directory.
export function createRunnerClients({ paths, apps = clientApps(),
  agentKits = agentKitPorts(paths, { runtimeConfigPath: paths.graphRuntimeConfigPath }) }) {
  const runtimeConfigPath = paths.graphRuntimeConfigPath;
  const customClients = customClientStore({ extensionsDir: agentKits.clientInstaller.extensionsDir });
  const observer = createClientConnectionObserver({
    installer: agentKits.clientInstaller,
    customClients,
    historyPath: join(paths.dataDir, 'client-connection-observations.json'),
    awaitingRestart: () => sessionsAwaitingRestart(runtimeConfigPath),
    consoleInstall: { nodePath: paths.clientNodePath, mcpServerPath: paths.mcpServerPath, version: FULI_VERSION },
    apps
  });
  const connectClient = createClientInstaller({ installer: agentKits.clientInstaller, apps, customClients });
  return {
    clientConnection: () => Object.fromEntries(['standard', 'vscode', 'server'].map((format) => [
      format, clientConnectionConfig({ nodePath: paths.clientNodePath, mcpServerPath: paths.mcpServerPath, runtimeConfigPath }, format)
    ])),
    clientConnectionStatus: () => observer.observe(),
    connectClient,
    restartClient: createClientRestart({ apps, connect: connectClient,
      inspect: (id) => inspectAgent(agentKits.clientInstaller, id) }),
    ...createCustomClients({ installer: agentKits.clientInstaller, store: customClients })
  };
}
