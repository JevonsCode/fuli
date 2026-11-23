import { join } from 'node:path';

import { inspectAgent } from '../agent-kits/client-detection.js';
import { customClientStore } from '../agent-kits/custom-clients.js';
import { agentKitPorts } from '../agent-kits/ports.js';
import { clientApps } from '../agents/client-apps.js';
import { sessionsAwaitingRestart } from '../mcp/process-registry.js';
import { FULI_VERSION } from '../package-metadata.js';
import { clientConnectionConfig } from '../setup/client-connection.js';
import { createClientConnectionObserver } from '../system/client-connection-status.js';
import { createClientFileReveal } from '../system/client-file-reveal.js';
import { createClientFirstRunAction } from '../system/client-first-run-action.js';
import { createClientInstaller } from '../system/client-connection-install.js';
import { createClientRestart } from '../system/client-restart.js';
import { createCustomClients } from '../system/custom-client-connection.js';

// The clients on a runner (docs/runner.md), for its console's 客户端接入:
// detected, connected and added here, with the same entries `fuli runner join`
// and `fuli setup` write on a runner, so the runner's page lists this
// computer's Codex, Cursor and the rest instead of the host's. The same parts
// as the console's system service, without anything of a graph runtime.
// paths: resolveSetupPaths() for the runner's data directory.
// status(): this follower's one status (follower-status.js), or null. The page
// says it, because a runner's clients behave differently from a host's: their
// lifecycle hooks do nothing here, so every task entry depends on the Agent
// calling FULI (docs/runner.md), and the two computers can be on different FULI
// versions (rec#144). The versions and which side is older come from that same
// status, so this page, `fuli status` and `fuli runner status` never differ.
export function createRunnerClients({ paths, apps = clientApps(), status = null,
  agentKits = agentKitPorts(paths, { runtimeConfigPath: paths.graphRuntimeConfigPath }) }) {
  const runtimeConfigPath = paths.graphRuntimeConfigPath;
  const customClients = customClientStore({ extensionsDir: agentKits.clientInstaller.extensionsDir });
  const observer = createClientConnectionObserver({
    installer: agentKits.clientInstaller,
    customClients,
    historyPath: join(paths.dataDir, 'client-connection-observations.json'),
    awaitingRestart: () => sessionsAwaitingRestart(runtimeConfigPath),
    consoleInstall: { nodePath: paths.clientNodePath, mcpServerPath: paths.mcpServerPath, version: FULI_VERSION },
    apps, presence: agentKits.clientPresence
  });
  const connectClient = createClientInstaller({ installer: agentKits.clientInstaller, apps, customClients,
    presence: agentKits.clientPresence });
  return {
    clientConnection: () => Object.fromEntries(['standard', 'vscode', 'server'].map((format) => [
      format, clientConnectionConfig({ nodePath: paths.clientNodePath, mcpServerPath: paths.mcpServerPath, runtimeConfigPath }, format)
    ])),
    clientConnectionStatus: async (options) => {
      const [observation, follower] = await Promise.all([observer.observe(options), status ? status() : null]);
      const versions = follower?.versions ?? null;
      const skew = versions?.skew ?? null;
      return { ...observation, runner: { version: skew?.runnerVersion ?? versions?.runner?.[0] ?? FULI_VERSION,
        hostName: follower?.paired ? follower.host.name : null, hostReachable: follower?.host?.reachable === true,
        hostVersion: versions?.host ?? null, ...(skew ? { skew: { older: skew.older } } : {}) } };
    },
    connectClient,
    runClientFirstRun: createClientFirstRunAction({ locate: agentKits.locateProgram }),
    revealClientFile: createClientFileReveal({ installer: agentKits.clientInstaller }),
    restartClient: createClientRestart({ apps, connect: connectClient,
      inspect: (id) => inspectAgent(agentKits.clientInstaller, id) }),
    ...createCustomClients({ installer: agentKits.clientInstaller, store: customClients })
  };
}
