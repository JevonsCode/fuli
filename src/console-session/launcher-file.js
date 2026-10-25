import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { restrictToOwner } from '../system/owner-only-directory.js';
import { CODE_TTL_MS } from './session.js';

export const LAUNCHER_DIRECTORY_PREFIX = 'fuli-console-';
// Where a console keeps its launcher directories: inside its data directory.
export const launcherParent = (dataDir) => join(dataDir, 'console-session');
export const LAUNCHER_FILE = /^sign-in-[0-9a-f-]{36}\.html$/;

// The file `fuli open` hands the browser instead of a URL with the code
// (rec#11 D-61), as Jupyter does: a command line is readable by other
// processes (on Linux /proc/*/cmdline by every account), a file in a private
// directory is not. The console makes a directory of its own under parent
// (launcherParent: the data directory's console-session folder, not the
// system temporary directory, whose ACL on Windows lets other groups create
// and rename entries, so they could swap a directory in before it is
// hardened; the data directory's parent grants them at most read). It makes
// that directory owner-only and checks it (restrictToOwner: mode 0700 on
// POSIX; owner, then an explicit owner-and-SYSTEM DACL on Windows, where mode
// bits are ignored) before any code is written, and writes each file 0600.
// If that fails nothing is written and write() throws, so the sign-in fails
// closed. It deletes a file once its code is redeemed or expires, and the
// whole directory when it stops. The page sends the browser on to the
// console's sign-in page with the code in the URL's fragment, which a browser
// never sends to a server or in a Referer.
export function createSignInLaunchers({ parent, ttlMs = CODE_TTL_MS, setTimer = setTimeout,
  clearTimer = clearTimeout, ownerOnly = restrictToOwner } = {}) {
  let directory = null;
  const files = new Map();
  const remove = (code) => {
    const file = files.get(code);
    if (!file) return;
    files.delete(code);
    clearTimer(file.timer);
    rmSync(file.path, { force: true });
  };
  const privateDirectory = () => {
    const root = parent?.();
    if (!root) throw new Error('Signing in to the console needs its data directory');
    mkdirSync(root, { recursive: true });
    const created = mkdtempSync(join(root, LAUNCHER_DIRECTORY_PREFIX));
    try {
      ownerOnly(created);
    } catch (error) {
      rmSync(created, { recursive: true, force: true });
      throw new Error('Could not make the sign-in file private to this account, so no sign-in was written', { cause: error });
    }
    return created;
  };
  return {
    // The launcher's path; the code is only inside it.
    write(code, consoleOrigin) {
      directory ??= privateDirectory();
      const path = join(directory, `sign-in-${randomUUID()}.html`);
      writeFileSync(path, launcherPage(`${consoleOrigin}/auth/console#code=${code}`), { mode: 0o600, flag: 'wx' });
      const timer = setTimer(() => remove(code), ttlMs);
      timer?.unref?.();
      files.set(code, { path, timer });
      return path;
    },
    remove,
    close() {
      for (const code of [...files.keys()]) remove(code);
      if (directory) rmSync(directory, { recursive: true, force: true });
      directory = null;
    }
  };
}

// The code is base64url and the origin a loopback address, so neither needs escaping.
function launcherPage(target) {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${target}">
<title>FULI</title>
<script>location.replace(${JSON.stringify(target)})</script>
`;
}
