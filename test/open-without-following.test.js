import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBearerToken } from '../src/cli/remote-mcp-command.js';
import { openWithoutFollowing } from '../src/system/open-without-following.js';
import { requiresSymlinks } from '../test-support/platform-capabilities.js';

// The Windows branch (no O_NOFOLLOW) runs on every platform through fakes.
const stat = (ino, link = false) => ({ dev: 1n, ino, isSymbolicLink: () => link });
function windowsFs({ entry, opened }) {
  const calls = { closed: 0 };
  return { calls, fs: {
    lstat: async () => { if (entry instanceof Error) throw entry; return entry; },
    open: async () => ({ stat: async () => opened, close: async () => { calls.closed += 1; } }),
  } };
}

test('without O_NOFOLLOW a symbolic link is refused before it is opened', async () => {
  const { fs } = windowsFs({ entry: stat(7n, true), opened: stat(7n) });
  await assert.rejects(openWithoutFollowing('x', constants.O_RDONLY, undefined, { noFollow: null, fs }),
    error => error.code === 'ELOOP');
});

test('without O_NOFOLLOW a file swapped after the check is refused and its handle closed', async () => {
  const { fs, calls } = windowsFs({ entry: stat(7n), opened: stat(8n) });
  await assert.rejects(openWithoutFollowing('x', constants.O_RDONLY, undefined, { noFollow: null, fs }),
    error => error.code === 'ELOOP');
  assert.equal(calls.closed, 1);
});

test('without O_NOFOLLOW the same regular file opens, and a missing file may be created', async () => {
  const same = windowsFs({ entry: stat(7n), opened: stat(7n) });
  assert.ok(await openWithoutFollowing('x', constants.O_RDONLY, undefined, { noFollow: null, fs: same.fs }));
  let checks = 0;
  const created = { lstat: async () => {
    checks += 1;
    if (checks === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return stat(9n);
  }, open: async () => ({ stat: async () => stat(9n), close: async () => {} }) };
  assert.ok(await openWithoutFollowing('x', constants.O_RDWR | constants.O_CREAT, 0o600, { noFollow: null, fs: created }));
  assert.equal(checks, 2);
});

test('the platform helper refuses a real symbolic link', requiresSymlinks, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-no-follow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'target');
  await writeFile(target, 'data');
  await symlink(target, join(directory, 'link'));
  await assert.rejects(openWithoutFollowing(join(directory, 'link')));
  const file = await openWithoutFollowing(target);
  await file.close();
});

test('the bearer token reader tells apart file IDs that round to the same Number (rec#49)', () => {
  // Two Windows file IDs one apart above 2^53: equal as Numbers, distinct as BigInt.
  const [before, after] = [9007199254740993n, 9007199254740992n];
  assert.equal(Number(before), Number(after));
  const stat = (ino, bigint) => ({ dev: bigint ? 7n : 7, ino: bigint ? ino : Number(ino), size: 40, mode: 0o600,
    isSymbolicLink: () => false, isFile: () => true });
  assert.throws(() => readBearerToken('/synthetic/token', {
    constants: { O_RDONLY: 0, O_NONBLOCK: 0 },
    lstatSync: (_path, options) => stat(before, options?.bigint),
    openSync: () => 3,
    fstatSync: (_descriptor, options) => stat(after, options?.bigint),
    readFileSync: () => { throw new Error('must not read a replaced file'); },
    closeSync: () => {}
  }), /symbolic link/);
});

test('the bearer token reader refuses a link where O_NOFOLLOW does not exist', () => {
  assert.throws(() => readBearerToken('/synthetic/token', {
    constants: { O_RDONLY: 0, O_NONBLOCK: 0 },
    lstatSync: () => ({ isSymbolicLink: () => true }),
    openSync: () => { throw new Error('must not open'); },
  }), /symbolic link/);
});
