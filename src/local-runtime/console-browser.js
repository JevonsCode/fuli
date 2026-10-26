import { spawn } from 'node:child_process';

import { isSignInLauncher } from '../console-session/sign-in-launcher.js';

// Opens the local console, or a console sign-in launcher (rec#11 D-61), in
// this computer's default browser. `fuli open` and the console's sign-in
// button (D-69) both use it. Resolves once the opener started and rejects
// when it could not, so a console process never crashes on a missing opener.
export async function openConsoleInBrowser(target, { spawnImpl = spawn, platform = process.platform } = {}) {
  const invocation = externalOpenInvocation(target, platform);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(invocation.command, invocation.args, { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function externalOpenInvocation(url, platform = process.platform) {
  if (!isLoopbackConsoleUrl(url) && !isSignInLauncher(url)) throw new TypeError('Only the local Fuli console can be opened');
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

export function isLoopbackConsoleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) &&
      url.username === '' && url.password === '' &&
      (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash;
  } catch {
    return false;
  }
}
