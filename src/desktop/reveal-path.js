import { spawn } from 'node:child_process';

import { ApplicationError } from '../app/application-error.js';

// Shows one file or folder FULI wrote in the system file manager (Explorer on
// Windows, Finder on macOS), selected. Only for paths the caller produced
// itself; it never opens or runs what it shows. spawnProcess and platform
// are seams for tests.
export function revealPath(path, { platform = process.platform, spawnProcess = spawn } = {}) {
  const [command, args] = platform === 'win32' ? ['explorer.exe', [`/select,"${path}"`]]
    : platform === 'darwin' ? ['open', ['-R', path]] : [null, []];
  if (!command) throw new ApplicationError('reveal_unavailable', 'FULI cannot show a folder on this platform.', { status: 409 });
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: platform === 'win32' });
    child.once('error', () => reject(new ApplicationError('reveal_unavailable', 'FULI could not open the folder.', { status: 409 })));
    child.once('spawn', () => {
      child.unref();
      resolve({ revealed: true });
    });
  });
}
