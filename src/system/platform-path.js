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
// The server of a UNC path, also in its \\?\UNC\ and \\.\UNC\ forms, with
// either slash and any case.
const UNC_SERVER = /^[\\/]{2,}(?:[?.][\\/]+UNC[\\/]+)?([^\\/]*)/i;
const WSL_SERVERS = new Set(['wsl$', 'wsl.localhost']);

// A path a caller reported, as a host with these path rules opens it, or null
// when that host has no path for it. An Agent in WSL reports /mnt/<drive>/... to
// a Windows FULI; that is the Windows drive, after the POSIX path is normalized
// so .. cannot cross into another mount or out of the mounts. Any other POSIX
// path (/home, /tmp) and the WSL shares (\\wsl$, \\wsl.localhost) are inside the
// WSL file system, which a Windows FULI does not resolve projects in. POSIX
// hosts and native Windows paths are unchanged.
export function hostPathOfCallerPath(callerPath, pathApi) {
  if (pathApi !== win32) return callerPath;
  if (posixRooted(callerPath)) return wslDrivePath(posix.normalize(callerPath));
  const server = UNC_SERVER.exec(callerPath)?.[1].toLowerCase();
  return WSL_SERVERS.has(server) ? null : callerPath;
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
