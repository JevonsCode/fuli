import { homedir } from 'node:os';

import { integrationContext } from '../setup/integration-context.js';
import { createClientInstallerPort } from './client-installer.js';
import { agentKitExecutables } from './executables.js';
import { openCodePluginGate } from './opencode-plugin-gate.js';
import { createSessionLauncherPort } from './session-launcher.js';

// The shared client components for one data directory (setup paths), wired
// once: where their executables are found and the ports FULI calls them through.
export function agentKitPorts(paths, { env = process.env, homeDir = homedir(), runtimeConfigPath = paths.graphRuntimeConfigPath } = {}) {
  const executables = agentKitExecutables({ nativeRuntimeDir: paths.nativeRuntimeDir, bundleRoot: paths.portableRoot, env });
  return {
    sessionLauncher: createSessionLauncherPort({ executables, configPath: paths.launcherHostConfigPath }),
    clientInstaller: createClientInstallerPort({ executables, manifestPath: paths.installerManifestPath,
      context: integrationContext(paths, runtimeConfigPath), backupsDir: paths.backupDir,
      openCode: () => openCodePluginGate({ env, homeDir }) })
  };
}
