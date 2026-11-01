import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApplicationError } from '../app/application-error.js';

// Opens a terminal window on this computer that runs one FULI command, for a
// step that must be answered at an interactive terminal (the app approval's
// typed confirmation, rec#11 D-36.9). The console never tells the person to
// type a command: it asks FULI to open the window, and the person answers in
// it. The window is the person's: FULI does not read it or wait for it, and
// answers once the window process is launched.
//
// command: [executable, ...arguments], each an absolute path or a token the
// caller validated. Windows: a new console window of cmd /k, so the window
// stays after the command ends; a path holding % or " is refused, since cmd
// would expand or end it. macOS: a one-shot .command script opened in
// Terminal, which deletes itself first. Elsewhere there is no terminal FULI
// knows how to open. spawnProcess, platform and directory are seams for tests.
export async function openTerminalWindow(command, {
  platform = process.platform, spawnProcess = spawn, directory = () => mkdtempSync(join(tmpdir(), 'fuli-terminal-'))
} = {}) {
  if (platform === 'win32') {
    if (command.some((part) => /[%"\r\n]/.test(part))) throw unavailable('This command cannot be passed to a Windows console safely.');
    // cmd /k "<line>": cmd drops the outer quotes and runs the line as written.
    const line = command.map((part) => `"${part}"`).join(' ');
    return launched(spawnProcess('cmd.exe', ['/d', '/k', `"${line}"`],
      { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }));
  }
  if (platform === 'darwin') {
    const script = join(directory(), 'fuli-confirm.command');
    writeFileSync(script, `#!/bin/sh\nrm -f -- "$0"\n${command.map(shellQuoted).join(' ')}\n`, { mode: 0o700 });
    chmodSync(script, 0o700);
    return launched(spawnProcess('open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' }));
  }
  throw unavailable('FULI cannot open a terminal window on this platform.');
}

function launched(child) {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(unavailable('FULI could not open a terminal window on this computer.')));
    child.once('spawn', () => {
      child.unref();
      resolve({ opened: true });
    });
  });
}

const shellQuoted = (part) => `'${part.replaceAll("'", "'\\''")}'`;

const unavailable = (message) => new ApplicationError('terminal_unavailable', message, { status: 409 });
