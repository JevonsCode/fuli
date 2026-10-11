import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Version managers such as nvm-windows install each Node version in its own
// folder and expose the active one through a symlink (C:\nvm4w\nodejs). The
// module URL resolves to the versioned folder, which breaks client configs on
// the next `nvm use`. Prefer the same package seen through the active Node's
// directory when it is the identical install.
export function stablePackageRoot(root, {
  execPath = process.execPath,
  exists = existsSync,
  realpath = realpathSync
} = {}) {
  const nodeDir = dirname(execPath);
  const name = basename(root);
  const candidates = [
    join(nodeDir, 'node_modules', name),
    join(dirname(nodeDir), 'lib', 'node_modules', name)
  ];
  let real;
  try { real = realpath(root); } catch { return root; }
  for (const candidate of candidates) {
    if (candidate === root || !exists(candidate)) continue;
    try {
      if (realpath(candidate) === real) return candidate;
    } catch { /* unreadable candidate */ }
  }
  return root;
}
