import { execFileSync } from 'node:child_process';
import { chmodSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

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
  // Windows paths whatever this process runs on, so an injected platform composes them the same way.
  const system32 = win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32');
  const tool = (name, args, options = {}) => String(run(win32.join(system32, name), args,
    { encoding: 'utf8', windowsHide: true, ...options }));
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(tool('whoami.exe', ['/user', '/fo', 'csv', '/nh']))?.[1];
  if (!sid) throw new Error('The current Windows account could not be identified');
  tool('icacls.exe', [directory, '/setowner', `*${sid}`]);
  tool('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, `*${LOCAL_SYSTEM_SID}:(OI)(CI)F`]);
  const actual = readWindowsAcl(directory, tool, env);
  const expected = [sid, LOCAL_SYSTEM_SID].sort();
  const allowed = [...new Set(actual.rules.filter(rule => rule.allow).map(rule => rule.sid))].sort();
  if (actual.owner !== sid || actual.protected !== true || actual.rules.some(rule => !rule.allow)
    || JSON.stringify(allowed) !== JSON.stringify(expected)) {
    throw new Error('The directory is not owned by this account with access for it and SYSTEM only');
  }
}

// The owner, whether inheritance is off, and every access rule, as SIDs, so
// localized and unresolved names compare too. Only .NET and the language
// itself, no cmdlet, and without PSModulePath: a Windows PowerShell started
// from PowerShell 7 (a CI runner, a pwsh terminal) inherits a module path it
// cannot load Get-Acl's module from.
function readWindowsAcl(directory, tool, env) {
  const literal = directory.replace(/'/g, "''");
  const script = `$acl = [System.IO.DirectoryInfo]::new('${literal}').GetAccessControl(); `
    + `$sid = [System.Security.Principal.SecurityIdentifier]; `
    + `'owner=' + $acl.GetOwner($sid).Value; 'protected=' + $acl.AreAccessRulesProtected; `
    + `foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) { 'rule=' + $rule.IdentityReference.Value + '|' + $rule.AccessControlType }`;
  const withoutModulePath = Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  const lines = tool(win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: withoutModulePath }).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const value = (key) => lines.find(line => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
  return { owner: value('owner'), protected: value('protected') === 'True',
    rules: lines.filter(line => line.startsWith('rule=')).map(line => {
      const [sid, type] = line.slice('rule='.length).split('|');
      return { sid, allow: type === 'Allow' };
    }) };
}
