import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// The per-user/data mutex the tray app holds while it runs ("Global\FuliTray-<SID>-<key>"):
// the FULI desktop client now (desktop/flutter/lib/src/platform/desktop/windows_instance.dart),
// FuliTray.exe before it. The name stays so an update from either side finds the other.
function trayMutexScript(dataDir) {
  if (process.platform !== 'win32') throw new Error('Windows updates require Windows.');
  const key = createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 32);
  return '$ErrorActionPreference="Stop"; '
    + '$name="Global\\FuliTray-"+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+"-' + key + '"; ';
}

const powershellPath = () => join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const encoded = script => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

// Hold the same per-user/data mutex as the tray app for the entire transaction.
// A running client or another updater must finish before any services are stopped.
export async function acquireWindowsUpdateLock(dataDir) {
  const script = trayMutexScript(dataDir)
    + '$m=New-Object Threading.Mutex($false,$name); $owned=$false; try { '
    + 'try {$owned=$m.WaitOne(0)} catch [Threading.AbandonedMutexException] {$owned=$true}; '
    + 'if(-not $owned){throw "Close the FULI desktop client and other FULI updaters, then try again."}; '
    + '[Console]::WriteLine("FULI_UPDATE_LOCKED"); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null '
    + '} finally {if($owned){$m.ReleaseMutex()};$m.Dispose()}';
  const child = spawn(powershellPath(), encoded(script), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false;
  const completion = new Promise(resolve => { child.once('close', code => { closed = true; resolve(code); }); });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out acquiring the Windows tray lock.')); }, 15000);
    const fail = () => { clearTimeout(timer); reject(new Error('Close the FULI desktop client and other FULI updaters, then try again.')); };
    child.once('error', fail); child.once('close', fail);
    child.stdout.on('data', bytes => {
      output += bytes;
      if (output.includes('FULI_UPDATE_LOCKED')) { clearTimeout(timer); resolve(); }
    });
  });
  return {
    assertHeld() { if (closed || child.exitCode !== null) throw new Error('The Windows update lock was lost.'); },
    async release() { child.stdin.end('\n'); await completion; }
  };
}

// Updates ask a running tray app to exit (its "-exit" event; the
// services keep running) and wait until the tray mutex is free. A client in the
// middle of an operation exits when it finishes. Resolves 'exited', 'absent'
// (no tray was running) or 'busy' (still there after timeoutMs).
export function requestWindowsTrayExit(dataDir, { timeoutMs }) {
  const script = trayMutexScript(dataDir) + '$running=$false; '
    + 'try { $e=[Threading.EventWaitHandle]::OpenExisting($name+"-exit"); [void]$e.Set(); $e.Dispose(); $running=$true } '
    + 'catch [Threading.WaitHandleCannotBeOpenedException] {}; '
    + '$m=New-Object Threading.Mutex($false,$name); $owned=$false; try { '
    + 'try {$owned=$m.WaitOne(' + Math.trunc(timeoutMs) + ')} catch [Threading.AbandonedMutexException] {$owned=$true} '
    + '} finally {if($owned){$m.ReleaseMutex()};$m.Dispose()}; '
    + 'if(-not $owned){"busy"} elseif($running){"exited"} else {"absent"}';
  return new Promise(resolve => {
    execFile(powershellPath(), encoded(script), { windowsHide: true, timeout: timeoutMs + 30_000, encoding: 'utf8' },
      (error, stdout) => resolve(!error && ['exited', 'absent'].includes(stdout.trim()) ? stdout.trim() : 'busy'));
  });
}
