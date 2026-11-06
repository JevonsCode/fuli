import { posix, win32 } from 'node:path';

// Path rules of the platform a caller inspects or configures. They follow the
// explicit platform argument, not the host, so paths for macOS or Linux keep
// forward slashes even when the code runs on Windows.
export function platformPath(platform = process.platform) {
  return platform === 'win32' ? win32 : posix;
}

// A normalized POSIX path on a WSL drive mount. The rest holds no character a
// Windows name cannot (WSL stores those as other characters), so it names the
// same file on the drive.
const WSL_DRIVE_MOUNT = /^\/mnt\/([a-z])(?:\/([^\\:]*))?$/i;
// A WSL distribution's name as `wsl --list` shows it.
const WSL_DISTRIBUTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WSL_SHARE = '\\\\wsl.localhost\\';

// A path a caller reported, as a host with these path rules opens it, or null
// when that host has no path for it. An Agent in WSL reports /mnt/<drive>/... to
// a Windows FULI; that is the Windows drive, after the POSIX path is normalized
// so .. cannot cross into another mount or out of the mounts. Any other POSIX
// path (/home, /tmp) is inside a WSL distribution's own file system and names
// nothing on Windows until wslCallerPath turns it into that distribution's
// share. The shares (\\wsl.localhost, \\wsl$) are ordinary UNC paths Windows
// opens while the distribution runs. POSIX hosts and native paths are unchanged.
export function hostPathOfCallerPath(callerPath, pathApi) {
  if (pathApi !== win32) return callerPath;
  if (posixRooted(callerPath)) return wslDrivePath(posix.normalize(callerPath));
  return callerPath;
}

// A path an Agent running inside the named WSL distribution reported, as a
// Windows host opens it: a path in that distribution's own file system becomes
// its \\wsl.localhost share. /mnt/<drive> paths stay for hostPathOfCallerPath;
// POSIX hosts, native paths, a rest Windows cannot name and a distribution
// name that is not one are unchanged.
export function wslCallerPath(callerPath, distribution, pathApi) {
  if (pathApi !== win32 || typeof distribution !== 'string' || !WSL_DISTRIBUTION.test(distribution)
    || !posixRooted(callerPath)) return callerPath;
  const posixPath = posix.normalize(callerPath);
  if (WSL_DRIVE_MOUNT.test(posixPath) || /[\\:]/.test(posixPath)) return callerPath;
  return win32.join(`${WSL_SHARE}${distribution}\\`, posixPath);
}

// One leading slash, or three or more, is the POSIX root. Exactly two is
// implementation-defined in POSIX and a UNC path under Windows rules, so //x is
// read as UNC and never guessed to be a WSL path.
function posixRooted(callerPath) {
  const slashes = /^\/*/.exec(callerPath)[0].length;
  return slashes === 1 || slashes >= 3;
}

function wslDrivePath(posixPath) {
  const mount = WSL_DRIVE_MOUNT.exec(posixPath);
  if (!mount) return null;
  const drivePath = win32.join(`${mount[1].toUpperCase()}:\\`, mount[2] ?? '');
  return drivePath.length > 3 ? drivePath.replace(/\\+$/, '') : drivePath;
}
