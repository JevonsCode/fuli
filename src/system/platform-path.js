import { posix, win32 } from 'node:path';

// Path rules of the platform a caller inspects or configures. They follow the
// explicit platform argument, not the host, so paths for macOS or Linux keep
// forward slashes even when the code runs on Windows.
export function platformPath(platform = process.platform) {
  return platform === 'win32' ? win32 : posix;
}

const WSL_DRIVE_MOUNT = /^\/mnt\/([a-z])(?:\/(.*))?$/i;
const WSL_SHARE = /^[\\/]{2}wsl(?:\$|\.localhost)(?:[\\/]|$)/i;

// A path a caller reported, as a host with these path rules opens it, or null
// when that host has no path for it. An Agent in WSL reports /mnt/<drive>/... to
// a Windows FULI; that is the Windows drive. Any other POSIX path (/home, /tmp)
// and the \\wsl$ and \\wsl.localhost shares are inside the WSL file system, which
// a Windows FULI does not resolve projects in. POSIX hosts and native Windows
// paths are unchanged.
export function hostPathOfCallerPath(callerPath, pathApi) {
  if (pathApi !== win32) return callerPath;
  const mount = WSL_DRIVE_MOUNT.exec(callerPath);
  if (mount) {
    const drivePath = win32.join(`${mount[1].toUpperCase()}:\\`, mount[2] ?? '');
    return drivePath.length > 3 ? drivePath.replace(/\\+$/, '') : drivePath;
  }
  const posixRooted = callerPath.startsWith('/') && !callerPath.startsWith('//');
  return posixRooted || WSL_SHARE.test(callerPath) ? null : callerPath;
}
