import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { windowsDataAcl } from '../src/system/windows-data-acl.js';

// The real whoami and icacls on a fresh temporary directory this test creates
// and deletes; never a FULI data directory. Windows only (CI's node-windows).

const tool = (name) => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);

// Every allow ACE's SID, read independently of the module under test.
// SDDL writes SYSTEM as SY and the built-in Administrator (RID 500, CI's runner) as LA.
function allowedSids(path, scratch, user = '') {
  const saved = join(scratch, `acl-${Math.random().toString(36).slice(2)}`);
  execFileSync(tool('icacls.exe'), [path, '/save', saved], { windowsHide: true });
  const sddl = readFileSync(saved).toString('utf16le').split(/\r?\n/)[1];
  return [...sddl.matchAll(/\((?:A|OA|XA|ZA);[^;]*;[^;]*;[^;]*;[^;]*;([^;)]+)/g)].map(([, sid]) => sid === 'SY' ? 'S-1-5-18' : sid === 'LA' && user.endsWith('-500') ? user : sid);
}

test('the data directory ACL keeps only the current user and SYSTEM, for the directory and what it holds',
  { skip: process.platform !== 'win32' && 'Windows ACLs only' }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'acl-integration-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, 'Fuli');
    mkdirSync(join(dataDir, 'stores'), { recursive: true });
    writeFileSync(join(dataDir, 'graph-provider.env'), 'FULI_TEST_ONLY=synthetic\n');
    writeFileSync(join(dataDir, 'stores', 'synthetic.json'), '{}\n');
    // An explicit extra grant on a file: the reset must take it away too.
    execFileSync(tool('icacls.exe'), [join(dataDir, 'graph-provider.env'), '/grant', '*S-1-5-32-545:(R)'], { windowsHide: true });
    const user = execFileSync(tool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim().match(/"(S-1-[\d-]+)"$/)[1];

    const acl = windowsDataAcl();
    // Shared before, whatever the temporary directory inherits: SDDL names BUILTIN\Users (S-1-5-32-545) BU.
    assert.ok(allowedSids(join(dataDir, 'graph-provider.env'), root).includes('BU'));
    await acl.restrictToOwner(dataDir);

    assert.deepEqual(await acl.sharedWith(dataDir), []);
    for (const path of [dataDir, join(dataDir, 'graph-provider.env'), join(dataDir, 'stores'), join(dataDir, 'stores', 'synthetic.json')]) {
      assert.deepEqual([...new Set(allowedSids(path, root, user))].sort(), [user, 'S-1-5-18'].sort(), path);
    }
    // A file created afterwards inherits the same two principals.
    writeFileSync(join(dataDir, 'later.json'), '{}\n');
    assert.deepEqual([...new Set(allowedSids(join(dataDir, 'later.json'), root, user))].sort(), [user, 'S-1-5-18'].sort());
  });
