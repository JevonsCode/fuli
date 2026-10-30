import { createClientInstallerPort } from './client-installer.js';
import { agentKitExecutables } from './executables.js';
import { createSessionLauncherPort } from './session-launcher.js';

// The shared client components for one data directory (setup paths), wired
// once: where their executables are found and the ports FULI calls them through.
export function agentKitPorts(paths, { env = process.env } = {}) {
  const executables = agentKitExecutables({ nativeRuntimeDir: paths.nativeRuntimeDir, bundleRoot: paths.portableRoot, env });
  return {
    sessionLauncher: createSessionLauncherPort({ executables, configPath: paths.launcherHostConfigPath }),
    clientInstaller: createClientInstallerPort({ executables, manifestPath: paths.installerManifestPath })
  };
}
