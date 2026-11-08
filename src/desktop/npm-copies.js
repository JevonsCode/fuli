import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { inspectUpdateInstallation, npmGlobalPrefix, npmUninstallCommand } from '../cli/update-installation.js';
import { FULI_PACKAGE_NAME } from '../package-metadata.js';
import { platformPath } from '../system/platform-path.js';
import { samePackageRoot } from './desktop-app-package.js';

// The FULI copies npm installed on this machine beside the desktop app's own
// (`npm i -g fuli-context`): both use the same data directory, so the app
// takes over the service and the clients, and the person removes the npm
// copy when they choose. Only files are read: no launcher is executed and npm
// is never asked.
//
// A desktop app does not inherit the shell's PATH (a macOS app started from
// Finder sees /usr/bin:/bin), so the folders npm usually links its commands
// into are read too. The app's own CLI is not on PATH, so a `fl` found here
// is what a terminal runs.
//
// Answers [{ packageRoot, version, launchers: [path], shellCommands, removeCommand }];
// shellCommands: the bare commands (fl, fuli) a terminal answers with this copy.
// extraRoots: package roots known from elsewhere, such as the one a running
// console recorded; only an npm global package among them counts.
export function findNpmCopies({ ownRoot, extraRoots = [], env = process.env, platform = process.platform,
  homeDir = homedir(), inspect = inspectUpdateInstallation, listDirectory = readdirSync, readText = readFileSync } = {}) {
  const path = platformPath(platform);
  const pathKey = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const directories = [...(env[pathKey] ?? '').split(path.delimiter).filter(Boolean),
    ...usualNpmBinDirectories({ env, platform, homeDir, listDirectory })];
  const { launchers } = inspect({ env: { PATH: [...new Set(directories)].join(path.delimiter) }, platform });
  const copies = new Map();
  const add = (packageRoot, version, launcher = null) => {
    if (!npmUninstallCommand(packageRoot, platform) || samePackageRoot(packageRoot, ownRoot, { platform })) return;
    // A project's own node_modules (its folder has a package.json) is never an npm global install.
    if (packageVersion(path.join(npmGlobalPrefix(packageRoot, platform), 'package.json'), readText, { anyName: true })) return;
    const key = platform === 'win32' ? packageRoot.toLowerCase() : packageRoot;
    const copy = copies.get(key) ?? { packageRoot, version, launchers: [], removeCommand: npmUninstallCommand(packageRoot, platform) };
    if (launcher && !copy.launchers.includes(launcher)) copy.launchers.push(launcher);
    copies.set(key, copy);
  };
  for (const launcher of launchers) {
    if (launcher.version) add(path.dirname(path.dirname(launcher.target)), launcher.version, launcher.path);
  }
  for (const root of extraRoots) {
    if (typeof root !== 'string' || !root) continue;
    const version = packageVersion(path.join(root, 'package.json'), readText);
    if (version) add(root, version);
  }
  return [...copies.values()].map((copy) => ({ ...copy,
    shellCommands: [...new Set(copy.launchers.map((launcher) => path.basename(launcher).replace(/\.cmd$/i, '')))] }));
}

// Where npm links global commands when its own folder is not on the app's PATH.
function usualNpmBinDirectories({ env, platform, homeDir, listDirectory }) {
  const path = platformPath(platform);
  if (platform === 'win32') {
    return [path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'npm')];
  }
  const nvm = path.join(homeDir, '.nvm', 'versions', 'node');
  let nvmVersions = [];
  try { nvmVersions = listDirectory(nvm).map((version) => path.join(nvm, version, 'bin')); } catch { /* no nvm */ }
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(homeDir, '.npm-global', 'bin'),
    path.join(homeDir, '.volta', 'bin'), ...nvmVersions];
}

function packageVersion(file, readText, { anyName = false } = {}) {
  try {
    const manifest = JSON.parse(readText(file, 'utf8'));
    return (anyName || manifest.name === FULI_PACKAGE_NAME) && typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}
