import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { acquireWindowsUpdateLock, requestWindowsTrayExit } from '../src/desktop/windows-update-lock.js';

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

// A stand-in tray: holds the tray mutex and exits when its "-exit" event is set, as FuliTray.cs does.
function standInTray(dataDir) {
  const key = createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 32);
  const script = '$name="Global\\FuliTray-"+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+"-' + key + '"; '
    + '$m=New-Object Threading.Mutex($false,$name); [void]$m.WaitOne(0); '
    + '$e=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::AutoReset,$name+"-exit"); '
    + '[Console]::WriteLine("READY"); [Console]::Out.Flush(); [void]$e.WaitOne(60000); $m.ReleaseMutex()';
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

test('the one-click update asks a running tray to exit and waits for its lock', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-tray-exit-'));
  const tray = standInTray(dataDir);
  const trayExited = once(tray, 'exit');
  try {
    assert.match(String((await once(tray.stdout, 'data'))[0]), /READY/);
    assert.equal(await requestWindowsTrayExit(dataDir, { timeoutMs: 20_000 }), 'exited');
    await trayExited;
    assert.equal(await requestWindowsTrayExit(dataDir, { timeoutMs: 1000 }), 'absent');
    const updater = await acquireWindowsUpdateLock(dataDir);
    try { assert.equal(await requestWindowsTrayExit(dataDir, { timeoutMs: 500 }), 'busy'); }
    finally { await updater.release(); }
  } finally {
    if (tray.exitCode === null) tray.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
