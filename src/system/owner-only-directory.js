import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

const LOCAL_SYSTEM_SID = 'S-1-5-18';

// Makes a directory readable only by this OS account (and, on Windows, the
// operating system itself), whatever its parent allows. On POSIX that is mode
// 0700. Windows ignores Node's mode bits, so a directory under %TEMP% inherits
// whatever that folder grants (for example a sandbox group or an AppContainer
// capability); there the directory gets an explicit, protected DACL instead:
// inheritance removed, full control for the current user's SID and SYSTEM
// only, inherited by every file written into it. Throws when that cannot be
// done, so a caller never writes a secret into a directory others can read.
// The system tools are called by absolute path, with no shell.
export function restrictToOwner(directory, { platform = process.platform, env = process.env, run = execFileSync } = {}) {
  if (platform !== 'win32') {
    chmodSync(directory, 0o700);
    return;
  }
  const system32 = join(env.SystemRoot ?? 'C:\\Windows', 'System32');
  const user = String(run(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }));
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(user)?.[1];
  if (!sid) throw new Error('The current Windows account could not be identified');
  run(join(system32, 'icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, `*${LOCAL_SYSTEM_SID}:(OI)(CI)F`],
    { windowsHide: true, stdio: 'ignore' });
}
