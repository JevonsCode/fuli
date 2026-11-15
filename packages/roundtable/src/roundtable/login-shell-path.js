import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, join } from 'node:path';

// A desktop app on macOS, or a service started outside a terminal, runs with
// a shorter PATH than the person's shell. A client's command line installed
// under the home folder (~/.local/bin, a Homebrew or npm prefix) is then not
// found, and neither are the programs it starts itself (node). So when a
// command is not on FULI's own PATH, the person's login shell is asked for its
// PATH: the command is looked for there, and the client is started with those
// directories added after FULI's own. The answer is kept for a few minutes,
// since asking starts a shell; a shell that fails to answer is not asked again
// until then. Nothing is asked on Windows, where applications share one PATH.
const KEEP_MS = 5 * 60_000;
const SHELL_TIMEOUT_MS = 4000;
// The shell may print its own lines when it starts: the PATH is read between marks.
const MARK = '__FULI_LOGIN_PATH__';
const BETWEEN_MARKS = new RegExp(`${MARK}([^\\n]*)${MARK}`);
// Shell text only; the mark and the variable name are constants, nothing is interpolated from outside.
const PRINT_PATH = `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`;

let kept = null;

// The login shell's PATH, or null when it cannot be learned.
export function loginShellPath({ env = process.env, platform = process.platform, run = spawnSync, now = () => Date.now(),
  accountShell = () => userInfo().shell } = {}) {
  if (platform === 'win32') return null;
  if (kept && now() - kept.at < KEEP_MS) return kept.path;
  let path = null;
  try {
    // An application started by the desktop has no SHELL: the account's own shell is used.
    const named = env.SHELL || accountShell();
    // fish takes another syntax; zsh and bash both take this, and so does sh.
    const shell = /\/(?:ba|z)?sh$/.test(named ?? '') ? named : '/bin/sh';
    const result = run(shell, ['-lic', PRINT_PATH], { encoding: 'utf8', timeout: SHELL_TIMEOUT_MS, env, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result?.status === 0) path = BETWEEN_MARKS.exec(String(result.stdout ?? ''))?.[1] || null;
  } catch { /* an account without a shell, or one that cannot start: not learned */ }
  kept = { at: now(), path };
  return path;
}

// The program `name` in one of the login shell's directories, or null.
export function findInLoginShellPath(name, options = {}) {
  const path = loginShellPath(options);
  if (!path) return null;
  const isProgram = options.isProgram ?? programFile;
  return path.split(delimiter).filter(Boolean).map((directory) => join(directory, name)).find((file) => isProgram(file)) ?? null;
}

// The environment a client is started with: the login shell's directories
// after FULI's own, once that PATH was learned for a lookup. It never asks the
// shell itself, so a start costs nothing where every command was on the PATH.
export function withLoginShellPath(env) {
  if (!kept?.path) return env;
  const own = String(env.PATH ?? '').split(delimiter).filter(Boolean);
  const added = kept.path.split(delimiter).filter((directory) => directory && !own.includes(directory));
  return added.length ? { ...env, PATH: [...own, ...added].join(delimiter) } : env;
}

// For tests: what was learned is forgotten.
export function forgetLoginShellPath() { kept = null; }

function programFile(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
}
