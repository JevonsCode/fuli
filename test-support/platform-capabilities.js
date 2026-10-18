import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Operating-system capabilities that some tests depend on. Each skip names the
// missing capability so a skipped test is never mistaken for a passing one.

const posixFileModes = process.platform !== 'win32';

// Windows creates symlinks only with Developer Mode or administrator rights;
// junctions need neither, but they cannot stand in for a file symlink.
function canCreateSymlinks() {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-symlink-probe-'));
  try {
    writeFileSync(join(directory, 'target'), '');
    symlinkSync(join(directory, 'target'), join(directory, 'link'), 'file');
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return false;
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export const requiresSymlinks = Object.freeze({
  skip: canCreateSymlinks() ? false
    : 'creating symlinks needs Windows Developer Mode or administrator rights'
});

// chmod can make a path unreadable only where POSIX permission bits are
// enforced: NTFS ignores them, and root reads through them.
export const requiresPermissionDenial = Object.freeze({
  skip: !posixFileModes ? 'NTFS ignores POSIX permission bits, so chmod cannot deny access'
    : process.getuid?.() === 0 ? 'root reads through POSIX permission bits'
      : false
});

// Neo4j asset lifecycle tests build and extract Unix tar.gz packages and manage
// POSIX process groups; Windows uses the bundled tray runtime instead.
export const requiresUnixNativeAssets = Object.freeze({
  skip: process.platform === 'win32' ? 'Unix Neo4j tar.gz assets are managed only on macOS and Linux' : false
});

export const requiresPosixFileModes = Object.freeze({
  skip: posixFileModes ? false : 'NTFS stores no POSIX permission bits'
});

// Asserts the permission bits of a file or directory. NTFS keeps only the
// read-only attribute, which Node reports as the owner write bit, so Windows
// asserts that bit while POSIX asserts every bit.
export function assertFileMode(path, expected, message) {
  const mode = statSync(path).mode & 0o777;
  if (posixFileModes) assert.equal(mode, expected, message);
  else assert.equal(mode & 0o200, expected & 0o200, message);
}
