import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test from 'node:test';

import { createSignInLaunchers } from '../src/console-session/launcher-file.js';
import { restrictToOwner } from '../src/system/owner-only-directory.js';

// rec#11 D-61: the console's sign-in file lives in a directory only this OS
// account (and SYSTEM, on Windows) can read. Synthetic codes, temporary directories only.

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'p61-owner-only-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const USER = 'S-1-5-21-1-2-3-1001';
// A synthetic Windows: whoami names USER, icacls succeeds, and the ACL read answers acl.
function windows(acl) {
  const calls = [];
  const run = (file, args) => {
    calls.push([file, args]);
    if (file.endsWith('whoami.exe')) return `"host\\person","${USER}"\r\n`;
    if (file.endsWith('powershell.exe')) {
      return [`owner=${acl.owner}`, `protected=${acl.protected ? 'True' : 'False'}`,
        ...acl.rules.map(rule => `rule=${rule.sid}|${rule.allow ? 'Allow' : 'Deny'}`)].join('\r\n');
    }
    return '';
  };
  return { calls, run };
}
const OWNER_ONLY = { owner: USER, protected: true, rules: [{ sid: USER, allow: true }, { sid: 'S-1-5-18', allow: true }] };

// These two run on every host (Linux, macOS and Windows CI): the platform and the
// tools are injected, and the expected paths are Windows paths.
test('on Windows the directory is owned by the current user, then given a protected DACL for it and SYSTEM, and read back', () => {
  const { calls, run } = windows(OWNER_ONLY);
  restrictToOwner('C:\\Temp\\fuli-console-x', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run });
  assert.deepEqual(calls.map(([file, args]) => [file, args.slice(0, 5)]), [
    ['C:\\Windows\\System32\\whoami.exe', ['/user', '/fo', 'csv', '/nh']],
    ['C:\\Windows\\System32\\icacls.exe', ['C:\\Temp\\fuli-console-x', '/setowner', `*${USER}`]],
    ['C:\\Windows\\System32\\icacls.exe', ['C:\\Temp\\fuli-console-x', '/inheritance:r', '/grant:r',
      `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F']],
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      calls[3][1][3]]]
  ]);
  assert.ok(calls[3][1][3].includes("[System.IO.DirectoryInfo]::new('C:\\Temp\\fuli-console-x').GetAccessControl()"));
});

test('on Windows anything but exactly this owner and {user, SYSTEM} fails closed', () => {
  for (const [label, acl] of [
    ['another owner', { ...OWNER_ONLY, owner: 'S-1-5-21-9-9-9-666' }],
    ['inheritance left on', { ...OWNER_ONLY, protected: false }],
    ['a sandbox group', { ...OWNER_ONLY, rules: [...OWNER_ONLY.rules, { sid: 'S-1-5-21-1-2-3-3001', allow: true }] }],
    ['an AppContainer capability', { ...OWNER_ONLY, rules: [...OWNER_ONLY.rules, { sid: 'S-1-15-3-1', allow: true }] }],
    ['SYSTEM missing', { ...OWNER_ONLY, rules: [{ sid: USER, allow: true }] }],
    ['a deny rule', { ...OWNER_ONLY, rules: [...OWNER_ONLY.rules, { sid: 'S-1-1-0', allow: false }] }]]) {
    assert.throws(() => restrictToOwner('C:\\Temp\\x', { platform: 'win32', env: {}, run: windows(acl).run }),
      /not owned by this account with access for it and SYSTEM only/, label);
  }
  assert.throws(() => restrictToOwner('C:\\Temp\\x', { platform: 'win32', env: {}, run: () => 'no sid here' }),
    /could not be identified/);
  assert.throws(() => restrictToOwner('C:\\Temp\\x', { platform: 'win32', env: {},
    run: (file) => { if (file.endsWith('icacls.exe')) throw new Error('Access is denied'); return `"a","${USER}"`; } }), /Access is denied/);
});

test('a sign-in file is not written when its directory cannot be made owner-only', t => {
  const root = temporaryRoot(t);
  const launchers = createSignInLaunchers({ parent: () => root, ownerOnly: () => { throw new Error('icacls failed'); } });
  assert.throws(() => launchers.write('synthetic-code', 'http://127.0.0.1:2727'),
    /Could not make the sign-in file private to this account, so no sign-in was written/);
  assert.deepEqual(readdirSync(root), [], 'neither the directory nor a file is left');
});

test('the sign-in directory is readable only by its owner on this OS', { skip: process.platform === 'win32' && !existsSync(
  win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')) }, t => {
  const root = temporaryRoot(t);
  const launchers = createSignInLaunchers({ parent: () => root });
  t.after(() => launchers.close());
  const file = launchers.write('synthetic-code', 'http://127.0.0.1:2727');
  const directory = join(file, '..');
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    return;
  }
  const system32 = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const user = /"(S-1-[0-9-]+)"\s*$/m.exec(execFileSync(win32.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8' }))[1];
  // The owner and the effective ACL as SIDs, so unresolved and localized names compare too;
  // read through .NET, which loads in a Windows PowerShell started from PowerShell 7 too.
  // Read independently of the code under test, with .NET only and without
  // PSModulePath, so it works in a Windows PowerShell started from PowerShell 7 (CI).
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  const acl = (path, kind) => {
    const lines = execFileSync(win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive',
      '-Command', `$acl = [System.IO.${kind}]::new('${path.replace(/'/g, "''")}').GetAccessControl(); `
      + `$sid = [System.Security.Principal.SecurityIdentifier]; 'owner=' + $acl.GetOwner($sid).Value; `
      + `'protected=' + $acl.AreAccessRulesProtected; `
      + `foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) { 'rule=' + $rule.IdentityReference.Value + '|' + $rule.AccessControlType }`],
    { encoding: 'utf8', windowsHide: true, env }).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return { owner: lines.find(line => line.startsWith('owner='))?.slice(6), protected: lines.includes('protected=True'),
      rules: lines.filter(line => line.startsWith('rule=')).map(line => line.slice(5)) };
  };
  const expected = [`${user}|Allow`, 'S-1-5-18|Allow'].sort();
  const forDirectory = acl(directory, 'DirectoryInfo');
  assert.equal(forDirectory.owner, user, 'the directory is this account\'s');
  assert.equal(forDirectory.protected, true, 'nothing is inherited from its parent');
  assert.deepEqual([...new Set(forDirectory.rules)].sort(), expected);
  assert.deepEqual([...new Set(acl(file, 'FileInfo').rules)].sort(), expected, 'the file has only what the directory passes on');
});
