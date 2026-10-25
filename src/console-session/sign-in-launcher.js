import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { humanReviewToken } from '../graphiti/human-review-channel.js';
import { CODES_PATH, SIGN_IN_TOKEN_HEADER } from './http.js';
import { LAUNCHER_DIRECTORY_PREFIX, LAUNCHER_FILE, launcherParent } from './launcher-file.js';

const CODE_REQUEST_TIMEOUT_MS = 5_000;
// Characters cmd's `start` (or a shell) would read in an unquoted path.
const COMMAND_LINE_SPECIAL = /["&|<>^%!`$;]/;

// The sign-in `fuli open` hands the browser (rec#11 D-61): the running console
// issues a code for the data directory's human-review token (sent in a
// header) and answers the path of the owner-only launcher file that holds it
// (launcher-file.js). This process never sees the code, so it is never on a
// command line. next: the console path to land on, checked by the console.
// Throws when the console cannot sign in (an older console, no human-review
// channel, a refusal) or answers a path that is not such a launcher.
export async function consoleSignInLauncher({ consoleUrl, dataDir, next = null, fetchImpl = fetch,
  readToken = humanReviewToken }) {
  const response = await fetchImpl(new URL(CODES_PATH, consoleUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIGN_IN_TOKEN_HEADER]: readToken(dataDir) },
    body: JSON.stringify(next ? { next } : {}),
    signal: AbortSignal.timeout(CODE_REQUEST_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `the console answered HTTP ${response.status}`);
  }
  if (!isSignInLauncher(payload?.launcherPath, launcherParent(dataDir))) throw new Error('the console answered no sign-in file');
  return payload.launcherPath;
}

// A launcher the console wrote: <data directory>/console-session/fuli-console-*/sign-in-<uuid>.html,
// with nothing a command line would read specially. parent: the data
// directory's console-session folder when the caller knows it; without it,
// only the shape is checked.
export function isSignInLauncher(path, parent = null) {
  if (typeof path !== 'string' || !isAbsolute(path) || COMMAND_LINE_SPECIAL.test(path)) return false;
  const directory = dirname(path);
  const root = dirname(directory);
  return LAUNCHER_FILE.test(basename(path)) && basename(directory).startsWith(LAUNCHER_DIRECTORY_PREFIX)
    && (parent ? resolve(root) === resolve(parent) : basename(root) === basename(launcherParent('/')));
}
