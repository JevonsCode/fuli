import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  firstOpenPortNear,
  portRefusal,
  readReservedPortRanges,
  withoutReservedPorts
} from './reserved-ports.js';
import { DEFAULT_RUNTIME_SETTINGS, readRuntimeSettings, writeRuntimeSettings } from './runtime-settings.js';

// Moves the console to a port near the default that Windows does not reserve
// and nothing listens on, and any other FULI port out of a reserved range.
// The previous settings file is copied first; the caller restarts FULI.
export async function switchConsolePort(paths, {
  platform = process.platform,
  readRanges = readReservedPortRanges,
  probe = portRefusal,
  now = () => new Date()
} = {}) {
  const current = readRuntimeSettings(paths.runtimeSettingsPath);
  const ranges = readRanges({ platform });
  const ports = withoutReservedPorts(current.ports, ranges);
  const taken = new Set([current.ports.console,
    ...Object.entries(ports).filter(([key]) => key !== 'console').map(([, port]) => port)]);
  ports.console = await firstOpenPortNear(DEFAULT_RUNTIME_SETTINGS.ports.console, {
    ranges, taken, probe, host: current.lanAccess ? '0.0.0.0' : '127.0.0.1'
  });
  const backupPath = backupRuntimeSettings(paths, now());
  writeRuntimeSettings(paths.runtimeSettingsPath, { ...current, ports });
  return { previousPort: current.ports.console, port: ports.console, backupPath };
}

// A dated copy of the settings file, kept before FULI rewrites its ports.
export function backupRuntimeSettings(paths, at) {
  if (!existsSync(paths.runtimeSettingsPath)) return null;
  mkdirSync(paths.runtimeSettingsBackupDir, { recursive: true, mode: 0o700 });
  const stamp = at.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupPath = join(paths.runtimeSettingsBackupDir, `runtime-settings-${stamp}.json`);
  copyFileSync(paths.runtimeSettingsPath, backupPath);
  chmodSync(backupPath, 0o600);
  return backupPath;
}
