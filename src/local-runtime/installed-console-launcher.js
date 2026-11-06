import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalWindowsInstallPath, readWindowsInstallation } from '../desktop/windows-installation-context.js';
import { readMacosNativeBundle } from '../native-runtime/macos-assets.js';

const ownRoot = fileURLToPath(new URL('../..', import.meta.url));
const MACOS_APP_PACKAGE = /\.app\/Contents\/Resources\/fuli\/?$/;

// How an MCP process starts the console of an installed FULI (rec#94), always
// through the installed package's own Node and CLI with the data directory the
// MCP process uses: `fuli start --data-dir <dataDir> --automatic`, detached so
// it outlives the session. Installed means the Windows installation record's
// current package (installation.json, read again at every start, so an update
// starts the new version), the package inside FULI.app, or an npm
// installation. A source checkout or build folder is never started.
// Returns null when this package is none of those.
export function installedConsoleLauncher({ dataDir, packageRoot = ownRoot, platform = process.platform,
  execPath = process.execPath, env = process.env, spawnProcess = spawn } = {}) {
  const target = installedConsoleTarget({ dataDir, packageRoot, platform, execPath });
  if (!target) return null;
  return {
    start() {
      const spec = target();
      if (!spec) return false;
      const child = spawnProcess(spec.command, [spec.cli, 'start', '--data-dir', dataDir, '--automatic'],
        { cwd: spec.cwd, env, detached: true, stdio: 'ignore', windowsHide: true });
      child.on?.('error', () => {});
      child.unref?.();
      return true;
    }
  };
}

// () => { command, cli, cwd } of the installed package, or null when its
// record no longer names one; null instead of a function when this package
// is not an installed one.
export function installedConsoleTarget({ dataDir, packageRoot, platform, execPath }) {
  let installation = null;
  try { installation = readWindowsInstallation(packageRoot); } catch { return null; }
  if (installation) {
    const sameData = record => samePath(record.dataDir, dataDir);
    if (!sameData(installation)) return null;
    const recordPath = join(installation.installRoot, 'installation.json');
    return () => {
      let record;
      try { record = JSON.parse(readFileSync(recordPath, 'utf8')); } catch { return null; }
      if (record?.status !== 'installed' || typeof record.packageRoot !== 'string' || !sameData(record)) return null;
      return { command: join(record.packageRoot, 'runtime', 'node', 'node.exe'),
        cli: join(record.packageRoot, 'src', 'cli.js'), cwd: record.packageRoot };
    };
  }
  if (platform === 'darwin' && MACOS_APP_PACKAGE.test(packageRoot.replaceAll('\\', '/'))) {
    try { if (!readMacosNativeBundle(packageRoot)) return null; } catch { return null; }
    return () => ({ command: join(packageRoot, 'runtime', 'node', 'bin', 'node'),
      cli: join(packageRoot, 'src', 'cli.js'), cwd: packageRoot });
  }
  if (packageRoot.split(/[\\/]/).includes('node_modules')) {
    return () => ({ command: execPath, cli: join(packageRoot, 'src', 'cli.js'), cwd: packageRoot });
  }
  return null;
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try {
    return canonicalWindowsInstallPath(a).toLowerCase() === canonicalWindowsInstallPath(b).toLowerCase();
  } catch {
    return false;
  }
}
