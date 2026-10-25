import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('on Windows the directory gets a protected DACL for the current user\'s SID and SYSTEM, by absolute tool paths', () => {
  const calls = [];
  const run = (file, args) => {
    calls.push([file, args]);
    return file.endsWith('whoami.exe') ? '"host\\person","S-1-5-21-1-2-3-1001"\r\n' : '';
  };
  restrictToOwner('C:\\Temp\\fuli-console-x', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run });
  assert.deepEqual(calls, [
    ['C:\\Windows\\System32\\whoami.exe', ['/user', '/fo', 'csv', '/nh']],
    ['C:\\Windows\\System32\\icacls.exe', ['C:\\Temp\\fuli-console-x', '/inheritance:r', '/grant:r',
      '*S-1-5-21-1-2-3-1001:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F']]
  ]);
  assert.throws(() => restrictToOwner('C:\\Temp\\x', { platform: 'win32', env: {}, run: () => 'no sid here' }),
    /could not be identified/);
  assert.throws(() => restrictToOwner('C:\\Temp\\x', { platform: 'win32', env: {},
    run: (file) => { if (file.endsWith('icacls.exe')) throw new Error('Access is denied'); return '"a","S-1-5-21-9"'; } }), /Access is denied/);
});

test('a sign-in file is not written when its directory cannot be made owner-only', t => {
  const root = temporaryRoot(t);
  const launchers = createSignInLaunchers({ temporaryRoot: () => root, ownerOnly: () => { throw new Error('icacls failed'); } });
  assert.throws(() => launchers.write('synthetic-code', 'http://127.0.0.1:2727'),
    /Could not make the sign-in file private to this account, so no sign-in was written/);
  assert.deepEqual(readdirSync(root), [], 'neither the directory nor a file is left');
});

test('the sign-in directory is readable only by its owner on this OS', { skip: process.platform === 'win32' && !existsSync(
  join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')) }, t => {
  const root = temporaryRoot(t);
  const launchers = createSignInLaunchers({ temporaryRoot: () => root });
  t.after(() => launchers.close());
  const file = launchers.write('synthetic-code', 'http://127.0.0.1:2727');
  const directory = join(file, '..');
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    return;
  }
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const user = /"(S-1-[0-9-]+)"\s*$/m.exec(execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8' }))[1];
  // The effective ACL as SIDs, so unresolved and localized names compare too.
  const acl = (path) => JSON.parse(execFileSync(join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    `$acl = Get-Acl -LiteralPath '${path.replace(/'/g, "''")}'; ConvertTo-Json -Compress @{ protected = $acl.AreAccessRulesProtected; `
    + `rules = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value `
    + `+ '|' + $_.AccessControlType }) }`], { encoding: 'utf8', windowsHide: true }));
  const expected = [`${user}|Allow`, 'S-1-5-18|Allow'].sort();
  const forDirectory = acl(directory);
  assert.equal(forDirectory.protected, true, 'nothing is inherited from %TEMP%');
  assert.deepEqual([...new Set(forDirectory.rules)].sort(), expected);
  assert.deepEqual([...new Set(acl(file).rules)].sort(), expected, 'the file has only what the directory passes on');
});
