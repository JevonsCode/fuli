import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// Whether an Agent client's CLI is installed on this computer, so the console
// offers to open it in a terminal only where it can start. A program counts
// when it is on FULI's PATH, or, because FULI may run with a shorter PATH
// than the person's terminal (a desktop app on macOS), when the person's
// login shell finds it. On Windows a program that is only in the default WSL
// distribution counts as 'wsl' (OpenCode is often installed there). Answers
// are kept for a few minutes: the probes start shells, so the console never
// waits on them twice in a row.
//
// find(program) answers 'native', 'wsl' or null. `program` is a plain program
// name from the session launcher's plan; anything else is null.
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CACHE_MS = 5 * 60_000;
const SHELL_TIMEOUT_MS = 4000;
// The first WSL command can start the distribution.
const WSL_TIMEOUT_MS = 15_000;
// The program name is a positional parameter, never shell text.
const SHELL_PROBE = 'command -v -- "$1" >/dev/null';
const SHELL_LOCATE = 'command -v -- "$1"';

export function createCliPresence({
  platform = process.platform,
  env = process.env,
  run = runQuietly,
  capture = runCapturing,
  now = () => Date.now()
} = {}) {
  const cache = new Map();

  async function probe(program) {
    if (onPath(program, { platform, env })) return 'native';
    if (platform === 'win32') {
      if (!onPath('wsl', { platform, env })) return null;
      return await run('wsl.exe', ['--exec', 'bash', '-lic', SHELL_PROBE, 'probe', program], WSL_TIMEOUT_MS) ? 'wsl' : null;
    }
    // fish takes another syntax; zsh and bash both take this probe.
    const shell = /\/(?:ba|z)?sh$/.test(env.SHELL ?? '') ? env.SHELL : '/bin/sh';
    return await run(shell, ['-lic', SHELL_PROBE, 'probe', program], SHELL_TIMEOUT_MS) ? 'native' : null;
  }

  return {
    // The absolute path of a program this computer runs itself (never one only in
    // WSL), or null: what a caller runs when FULI's own PATH is shorter than the
    // person's terminal. Not cached; it is asked only when the person acts.
    async locate(program) {
      if (typeof program !== 'string' || !PROGRAM.test(program)) return null;
      const direct = onPathAt(program, { platform, env });
      if (direct || platform === 'win32') return direct;
      const shell = /\/(?:ba|z)?sh$/.test(env.SHELL ?? '') ? env.SHELL : '/bin/sh';
      const found = (await capture(shell, ['-lic', SHELL_LOCATE, 'probe', program], SHELL_TIMEOUT_MS))?.trim().split('\n').at(-1);
      return found && found.startsWith('/') && isProgram(found, platform) ? found : null;
    },
    async find(program) {
      if (typeof program !== 'string' || !PROGRAM.test(program)) return null;
      const cached = cache.get(program);
      if (cached && now() - cached.at < CACHE_MS) return cached.found;
      const found = await probe(program);
      cache.set(program, { found, at: now() });
      return found;
    }
  };
}

function onPath(program, options) {
  return onPathAt(program, options) !== null;
}

// The first matching program on PATH, or null.
function onPathAt(program, { platform, env }) {
  const directories = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const names = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((extension) => program + extension.toLowerCase())
    : [program];
  for (const directory of directories) {
    for (const name of names) if (isProgram(join(directory, name), platform)) return join(directory, name);
  }
  return null;
}

function isProgram(path, platform) {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Resolves whether the command exited with 0 within the time; never rejects.
function runQuietly(command, args, timeout) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, stdio: 'ignore' }, (error) => resolve(!error));
  });
}

// Resolves the command's standard output when it exited with 0 within the time, else null; never rejects.
function runCapturing(command, args, timeout) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout));
  });
}
