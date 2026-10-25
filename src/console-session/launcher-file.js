import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CODE_TTL_MS } from './session.js';

export const LAUNCHER_DIRECTORY_PREFIX = 'fuli-console-';
export const LAUNCHER_FILE = /^sign-in-[0-9a-f-]{36}\.html$/;

// The file `fuli open` hands the browser instead of a URL with the code
// (rec#11 D-61), as Jupyter does: a command line is readable by other
// processes (on Linux /proc/*/cmdline by every account), a file in a private
// directory is not. The console writes it owner-only (0600; the directory is
// 0700 from mkdtemp) into its own temporary directory and deletes it once the
// code is redeemed or expires, and the whole directory when it stops. The page
// sends the browser on to the console's sign-in page with the code in the
// URL's fragment, which a browser never sends to a server or in a Referer.
export function createSignInLaunchers({ temporaryRoot = tmpdir, ttlMs = CODE_TTL_MS, setTimer = setTimeout,
  clearTimer = clearTimeout } = {}) {
  let directory = null;
  const files = new Map();
  const remove = (code) => {
    const file = files.get(code);
    if (!file) return;
    files.delete(code);
    clearTimer(file.timer);
    rmSync(file.path, { force: true });
  };
  return {
    // The launcher's path; the code is only inside it.
    write(code, consoleOrigin) {
      directory ??= mkdtempSync(join(temporaryRoot(), LAUNCHER_DIRECTORY_PREFIX));
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
