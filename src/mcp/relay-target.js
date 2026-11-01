import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWindowsInstallation } from '../desktop/windows-installation-context.js';

const ownRoot = fileURLToPath(new URL('../..', import.meta.url));

// Where the stdio relay (stdio-relay.js) finds the server to run, read again at
// every check. An installed Windows copy keeps each version in its own folder
// and installation.json names the current one; any other copy is updated in
// place, so its package.json names the version on disk.
export function mcpServerTarget(args, { packageRoot = ownRoot, execPath = process.execPath } = {}) {
  let installed = null;
  try { installed = readWindowsInstallation(packageRoot); } catch { /* not a valid installation: in place */ }
  if (installed) {
    const recordPath = join(installed.installRoot, 'installation.json');
    return () => {
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      if (record.status !== 'installed' || typeof record.packageRoot !== 'string') return null;
      return {
        version: record.applicationVersion,
        command: join(record.packageRoot, 'runtime', 'node', 'node.exe'),
        args: [join(record.packageRoot, 'src', 'mcp-server.js'), ...args]
      };
    };
  }
  const script = join(packageRoot, 'src', 'mcp-server.js');
  return () => ({
    version: JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version,
    command: execPath,
    args: [script, ...args]
  });
}
