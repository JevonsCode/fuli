import { execFileSync } from 'node:child_process';
import { chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LOCAL_SYSTEM_SID = 'S-1-5-18';

// Makes a directory readable only by this OS account (and, on Windows, the
// operating system itself), whatever its parent allows, and checks that it
// is. On POSIX that is mode 0700, owned by this user. Windows ignores Node's
// mode bits, so a directory inherits whatever its parent grants (for example
// a sandbox group or an AppContainer capability under %TEMP%). There the
// directory is first owned by the current user's SID, then given an explicit,
// protected DACL: inheritance removed, full control for that SID and SYSTEM
// only, inherited by every file written into it. Then the owner and the DACL
// are read back. Throws when any step fails or the result is not exactly
// that, so a caller never writes a secret into a directory others can read.
// The system tools are called by absolute path, with no shell.
//
// Hardening cannot undo a directory another account swapped in before it
// ran, so callers create the directory under a parent only this account can
// write to (launcher-file.js).
export function restrictToOwner(directory, { platform = process.platform, env = process.env, run = execFileSync } = {}) {
  if (platform !== 'win32') {
    chmodSync(directory, 0o700);
    const stat = statSync(directory);
    if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw new Error('The directory is not this account\'s alone');
    return;
  }
  const system32 = join(env.SystemRoot ?? 'C:\\Windows', 'System32');
  const tool = (name, args) => String(run(join(system32, name), args, { encoding: 'utf8', windowsHide: true }));
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(tool('whoami.exe', ['/user', '/fo', 'csv', '/nh']))?.[1];
  if (!sid) throw new Error('The current Windows account could not be identified');
  tool('icacls.exe', [directory, '/setowner', `*${sid}`]);
  tool('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, `*${LOCAL_SYSTEM_SID}:(OI)(CI)F`]);
  const actual = readWindowsAcl(directory, tool);
  const expected = [sid, LOCAL_SYSTEM_SID].sort();
  const allowed = [...new Set(actual.rules.filter(rule => rule.allow).map(rule => rule.sid))].sort();
  if (actual.owner !== sid || actual.protected !== true || actual.rules.some(rule => !rule.allow)
    || JSON.stringify(allowed) !== JSON.stringify(expected)) {
    throw new Error('The directory is not owned by this account with access for it and SYSTEM only');
  }
}

// The owner, whether inheritance is off, and every access rule, as SIDs, so
// localized and unresolved names compare too.
function readWindowsAcl(directory, tool) {
  const literal = directory.replace(/'/g, "''");
  const script = `$acl = Get-Acl -LiteralPath '${literal}'; $sid = [System.Security.Principal.SecurityIdentifier]; `
    + `ConvertTo-Json -Compress @{ owner = $acl.GetOwner($sid).Value; protected = $acl.AreAccessRulesProtected; `
    + `rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object { @{ sid = $_.IdentityReference.Value; `
    + `allow = ($_.AccessControlType -eq 'Allow') } }) }`;
  return JSON.parse(tool(join('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script]));
}
