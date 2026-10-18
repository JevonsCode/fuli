import { posix, win32 } from 'node:path';

// Path rules of the platform a caller inspects or configures. They follow the
// explicit platform argument, not the host, so paths for macOS or Linux keep
// forward slashes even when the code runs on Windows.
export function platformPath(platform = process.platform) {
  return platform === 'win32' ? win32 : posix;
}
