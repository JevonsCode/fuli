import { resolveSetupPaths } from '../setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS, readRuntimeSettings } from '../system/runtime-settings.js';

// The local console of a data directory, as the CLI's console commands reach it.
export function localConsoleUrl({ dataDir, env = process.env }) {
  const paths = resolveSetupPaths({ dataDir, env });
  const settings = paths.runtimeSettingsPath ? readRuntimeSettings(paths.runtimeSettingsPath) : DEFAULT_RUNTIME_SETTINGS;
  return `http://127.0.0.1:${settings.ports.console}`;
}
