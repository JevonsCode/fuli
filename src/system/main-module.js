import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Node loads the entry module by its real path, while argv keeps the path the
// host typed. Version managers such as nvm-windows install packages behind a
// symlink, so a plain string comparison silently skips the entry point.
export function isMainModule(metaUrl, argvPath = process.argv[1]) {
  if (typeof argvPath !== 'string' || !argvPath) return false;
  const modulePath = fileURLToPath(metaUrl);
  try {
    return realpathSync(modulePath) === realpathSync(argvPath);
  } catch {
    return modulePath === resolve(argvPath);
  }
}
