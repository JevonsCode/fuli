import { homedir } from 'node:os';

import { integrationContext } from '../setup/integration-context.js';
import { createCliPresence } from './cli-presence.js';
import { createClientPresence } from './client-presence.js';
import { createClientInstallerPort } from './client-installer.js';
import { agentKitExecutables } from './executables.js';
import { retireLegacyHooks } from './legacy-hook-cleanup.js';
import { openCodePluginGate } from './opencode-plugin-gate.js';
import { createSessionLauncherPort } from './session-launcher.js';

// The shared client components for one data directory (setup paths), wired
// once: where their executables are found and the ports FULI calls them through.
// clientPrompts(): the prompt files each client keeps (installer-manifest.js).
// onProgress(line): told when this process waits for another FULI's download
// of a component (a CLI's output). waitForOthers false: answer at once that
// the component is being downloaded instead (executables.js).
export function agentKitPorts(paths, { env = process.env, homeDir = homedir(), runtimeConfigPath = paths.graphRuntimeConfigPath,
  clientPrompts, onProgress, waitForOthers = true } = {}) {
  const executables = agentKitExecutables({ nativeRuntimeDir: paths.nativeRuntimeDir, bundleRoot: paths.portableRoot, env,
    waitForOthers, ...(onProgress ? { onWait: ({ message }) => onProgress(message) } : {}) });
  const cliPresence = createCliPresence({ env });
  return {
    sessionLauncher: createSessionLauncherPort({ executables, configPath: paths.launcherHostConfigPath }),
    // Shared so one process asks the person's login shell about a command once
    // every few minutes, however many client reads happen meanwhile.
    clientPresence: createClientPresence({ presence: cliPresence }),
    // Where a client's program is, for the one step FULI runs on the person's click.
    locateProgram: (program) => cliPresence.locate(program),
    clientInstaller: createClientInstallerPort({ executables, manifestPath: paths.installerManifestPath,
      context: integrationContext(paths, runtimeConfigPath), backupsDir: paths.backupDir,
      openCode: () => openCodePluginGate({ env, homeDir }),
      retireLegacy: (ids) => retireLegacyHooks(ids, { env, homeDir, backupsDir: paths.backupDir }),
      ...(clientPrompts ? { clientPrompts } : {}) })
  };
}
