import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import { npmGlobalPrefix, npmUninstallCommand } from '../cli/update-installation.js';
import { FULI_PACKAGE_NAME } from '../package-metadata.js';
import { platformPath } from '../system/platform-path.js';

// Removes an npm copy of FULI the desktop app adopted (npm-adoption.js) when
// the person asks: `npm uninstall --global fuli-context --prefix <its prefix>`,
// run with the npm that installed it where that npm sits in the same prefix
// (Homebrew, nvm, nvm-windows), else the first npm found on PATH. Only the
// package and its links are removed: --ignore-scripts keeps any lifecycle
// script of an old version from running, and the data directory is never
// touched. Answers { status: 'uninstalled' | 'failed', version, manualCommand,
// error? }; a failure (no npm found, no permission) names the command the
// person runs themself.

const NPM_TIMEOUT_MS = 120_000;
const NPM_CLI = ['node_modules', 'npm', 'bin', 'npm-cli.js'];

export async function uninstallNpmCopy(copy, { platform = process.platform, env = process.env, execPath = process.execPath,
  exists = existsSync, run = runNode } = {}) {
  const manualCommand = npmUninstallCommand(copy.packageRoot, platform);
  const prefix = npmGlobalPrefix(copy.packageRoot, platform);
  const result = (status, extra = {}) => ({ status, version: copy.version, manualCommand, ...extra });
  if (!prefix) return result('failed', { error: 'not_npm_global' });
  const npm = findNpm(prefix, { platform, env, exists });
  if (!npm) return result('failed', { error: 'npm_not_found' });
  const path = platformPath(platform);
  const node = npm.node && exists(npm.node) ? npm.node : execPath;
  const pathKey = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const outcome = await run(node, [npm.cli, 'uninstall', '--global', FULI_PACKAGE_NAME, '--prefix', prefix, '--ignore-scripts'],
    { env: { ...env, [pathKey]: [path.dirname(node), env[pathKey]].filter(Boolean).join(path.delimiter) } });
  if (exists(copy.packageRoot)) {
    return result('failed', { error: outcome.code === 0 ? 'still_installed' : lastLine(outcome.stderr) || `npm exited ${outcome.code}` });
  }
  return result('uninstalled');
}

// npm's own CLI script and the Node beside it: first in the copy's prefix,
// then beside each folder on PATH.
function findNpm(prefix, { platform, env, exists }) {
  const path = platformPath(platform);
  const pathKey = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const roots = [prefix, ...(env[pathKey] ?? '').split(path.delimiter).filter(Boolean)
    .map((directory) => platform === 'win32' ? directory : path.dirname(directory))];
  for (const root of roots) {
    const layouts = platform === 'win32'
      ? [{ cli: path.join(root, ...NPM_CLI), node: path.join(root, 'node.exe') }]
      : [{ cli: path.join(root, 'lib', ...NPM_CLI), node: path.join(root, 'bin', 'node') }];
    const found = layouts.find(({ cli }) => exists(cli));
    if (found) return found;
  }
  return null;
}

function lastLine(text) {
  return String(text ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 400) ?? '';
}

function runNode(node, args, { env }) {
  return new Promise((resolve) => {
    execFile(node, args, { env, windowsHide: true, encoding: 'utf8', timeout: NPM_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout,
        stderr: stderr || (error && typeof error.code !== 'number' ? error.message : '') }));
  });
}
