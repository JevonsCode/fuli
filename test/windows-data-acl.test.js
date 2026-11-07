import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { keepDataDirectoryPrivate, windowsDataAcl } from '../src/system/windows-data-acl.js';

// Who can open FULI's data directory on Windows (rec#53). Every call goes
// through an injected `run`, so no real ACL is read or changed here; the
// integration test in windows-data-acl-integration.test.js uses the real tools
// on a temporary directory it creates.

const USER = 'S-1-5-21-1000-2000-3000-1001';
const OTHER_USER = 'S-1-5-21-1000-2000-3000-1004';
const SANDBOX = 'S-1-15-3-1024-1065365936';
const DATA_DIR = 'C:\\Users\\someone\\AppData\\Local\\Fuli';
const ICACLS = 'C:\\Windows\\System32\\icacls.exe';
const WHOAMI = 'C:\\Windows\\System32\\whoami.exe';

// A data directory as AppData\Local leaves it: inherited by sandboxes and other principals.
const INHERITED = `D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})(A;OICIID;0x1200a9;;;${OTHER_USER})`
  + `(A;OICIIOID;GA;;;${SANDBOX})`;
const OWNER_ONLY = `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})`;

function scratchRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'acl-unit-'));
  // macOS can still be releasing entries the fake icacls wrote (ENOTEMPTY); rm retries briefly.
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

// A fake whoami and icacls: /save writes the record icacls would (UTF-16LE,
// name line then SDDL); /reset and /inheritance change the fake ACL.
function fakeTools(t, { sddl, failReset = false, failSave = false, keepShared = false, user = USER }) {
  const calls = [];
  const state = { sddl };
  const run = async (command, args, options = {}) => {
    calls.push([command, args, options]);
    if (command === WHOAMI) return { stdout: `"desktop\\someone","${user}"\r\n`, stderr: '' };
    if (args[1] === '/save') {
      if (failSave) throw new Error('Access is denied.');
      writeFileSync(args[2], Buffer.from(`Fuli\r\n${state.sddl}\r\n`, 'utf16le'));
    } else if (args[1] === '/reset') {
      if (failReset) throw new Error('Successfully processed 3 files; Failed processing 1 files');
    } else if (args[1] === '/inheritance:r' && !keepShared) state.sddl = OWNER_ONLY;
    return { stdout: '', stderr: '' };
  };
  const acl = windowsDataAcl({ platform: 'win32', run, systemRoot: 'C:\\Windows', tempRoot: scratchRoot(t) });
  return { acl, calls, state };
}

test('a directory as AppData\\Local leaves it is shared; inherited and inherit-only ACEs count, SYSTEM and the person never', async (t) => {
  const { acl, calls } = fakeTools(t, { sddl: INHERITED });
  assert.deepEqual(await acl.sharedWith(DATA_DIR), ['BA', OTHER_USER, SANDBOX]);
  const [whoami, save] = calls.map(([command, args]) => [command, args]);
  assert.deepEqual(whoami, [WHOAMI, ['/user', '/fo', 'csv', '/nh']]);
  assert.equal(save[0], ICACLS);
  assert.deepEqual(save[1].slice(0, 2), [DATA_DIR, '/save']);
});

test('owner-only, deny and audit entries are not sharing; a null DACL is everyone', async (t) => {
  assert.deepEqual(await fakeTools(t, { sddl: OWNER_ONLY }).acl.sharedWith(DATA_DIR), []);
  // A deny ACE takes access away; an SACL entry grants nothing.
  const denied = `${OWNER_ONLY}(D;OICI;FA;;;WD)S:AI(AU;SAFA;FA;;;WD)`;
  assert.deepEqual(await fakeTools(t, { sddl: denied }).acl.sharedWith(DATA_DIR), []);
  // A conditional ACE nests parentheses; the ACEs after it are still read.
  const conditional = `D:PAI(A;OICI;FA;;;SY)(XA;OICI;FA;;;AU;(@User.Project == "x"))(A;OICI;FA;;;${USER})(A;;FR;;;BU)`;
  assert.deepEqual(await fakeTools(t, { sddl: conditional }).acl.sharedWith(DATA_DIR), ['AU', 'BU']);
  assert.deepEqual(await fakeTools(t, { sddl: 'D:NO_ACCESS_CONTROL' }).acl.sharedWith(DATA_DIR), ['WD']);
});

test('the built-in Administrator (RID 500), written LA in SDDL, is the person when it runs FULI', async (t) => {
  const builtIn = 'D:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)';
  assert.deepEqual(await fakeTools(t, { sddl: builtIn, user: 'S-1-5-21-1000-2000-3000-500' }).acl.sharedWith(DATA_DIR), []);
  assert.deepEqual(await fakeTools(t, { sddl: builtIn }).acl.sharedWith(DATA_DIR), ['LA']);
});

test('an ACL that cannot be read is an error, never an owner-only answer, and leaves no scratch file', async (t) => {
  const root = scratchRoot(t);
  const calls = [];
  const run = async (command, args) => {
    calls.push(args);
    if (command === WHOAMI) return { stdout: `"desktop\\someone","${USER}"`, stderr: '' };
    writeFileSync(args[2], Buffer.from('Fuli\r\n', 'utf16le'));
    return { stdout: '', stderr: '' };
  };
  const acl = windowsDataAcl({ platform: 'win32', run, systemRoot: 'C:\\Windows', tempRoot: root });
  await assert.rejects(acl.sharedWith(DATA_DIR), /did not save a DACL/);
  assert.deepEqual(readdirSync(root), []);
  await assert.rejects(fakeTools(t, { sddl: OWNER_ONLY, failSave: true }).acl.sharedWith(DATA_DIR), /Access is denied/);
  const noSid = windowsDataAcl({ platform: 'win32', tempRoot: root, run: async (command, args) => {
    if (command !== WHOAMI) writeFileSync(args[2], Buffer.from(`Fuli\r\n${OWNER_ONLY}\r\n`, 'utf16le'));
    return { stdout: command === WHOAMI ? 'INFO: no user' : '', stderr: '' };
  } });
  await assert.rejects(noSid.sharedWith(DATA_DIR), /SID/);
});

test('limiting resets every entry, then grants only the person and SYSTEM, without a shell', async (t) => {
  const { acl, calls } = fakeTools(t, { sddl: INHERITED });
  await acl.restrictToOwner(DATA_DIR);
  const changes = calls.filter(([command, args]) => command === ICACLS && args[1] !== '/save');
  assert.deepEqual(changes.map(([command, args]) => [command, args]), [
    [ICACLS, [DATA_DIR, '/reset', '/T', '/C', '/Q']],
    [ICACLS, [DATA_DIR, '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/C', '/Q']]
  ]);
  for (const [, , options] of changes) assert.equal(options.timeout, 600_000);
});

test('a reset that misses a file still protects the directory, then reports the miss; one still shared fails', async (t) => {
  const partial = fakeTools(t, { sddl: INHERITED, failReset: true });
  await assert.rejects(partial.acl.restrictToOwner(DATA_DIR), /Failed processing 1 files/);
  assert.equal(partial.state.sddl, OWNER_ONLY);
  await assert.rejects(fakeTools(t, { sddl: INHERITED, keepShared: true }).acl.restrictToOwner(DATA_DIR),
    /can still open the data directory/);
});

test('outside Windows nothing is read or changed', async () => {
  const acl = windowsDataAcl({ platform: 'darwin', run: async () => assert.fail('no tool runs outside Windows') });
  assert.deepEqual(await acl.sharedWith('/Users/someone/.fuli'), []);
  await acl.restrictToOwner('/Users/someone/.fuli');
});

test('setup creates the data directory and limits it only when it is shared; a failure does not stop setup', async (t) => {
  const root = scratchRoot(t);
  const restricted = [];
  const acl = (shared, { fail = false } = {}) => ({
    sharedWith: async () => { if (fail) throw new Error('Access is denied.'); return shared; },
    restrictToOwner: async (directory) => { restricted.push(directory); }
  });
  const dataDir = join(root, 'Fuli');
  assert.equal(await keepDataDirectoryPrivate(dataDir, acl(['BA']), dataDir), true);
  assert.equal(existsSync(dataDir), true);
  assert.deepEqual(restricted, [dataDir]);
  assert.equal(await keepDataDirectoryPrivate(dataDir, acl([]), dataDir), true);
  assert.deepEqual(restricted, [dataDir]);
  assert.equal(await keepDataDirectoryPrivate(dataDir, acl([], { fail: true }), dataDir), false);

  // A folder the person chose may be shared on purpose: setup leaves its ACL alone.
  const chosen = join(root, 'Shared');
  assert.equal(await keepDataDirectoryPrivate(chosen, acl(['BA']), dataDir), true);
  assert.equal(existsSync(chosen), true);
  assert.deepEqual(restricted, [dataDir]);
});
