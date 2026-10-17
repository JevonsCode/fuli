import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWindowsUpdateLock } from '../src/desktop/windows-update-lock.js';

test('Windows updater excludes another owner and releases its tray mutex', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-update-mutex-'));
  try {
    const first = await acquireWindowsUpdateLock(dataDir);
    try {
      first.assertHeld();
      await assert.rejects(acquireWindowsUpdateLock(dataDir), /tray|updater/);
      first.assertHeld();
    } finally { await first.release(); }
    const next = await acquireWindowsUpdateLock(dataDir);
    try { next.assertHeld(); } finally { await next.release(); }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
