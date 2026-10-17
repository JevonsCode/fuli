import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Hold the same per-user/data mutex as FuliTray for the entire transaction.
// A running tray or another updater must finish before any services are stopped.
export async function acquireWindowsUpdateLock(dataDir) {
  if (process.platform !== 'win32') throw new Error('Windows updates require Windows.');
  const key = createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 32);
  const script = '$ErrorActionPreference="Stop"; '
    + '$name="Global\\FuliTray-"+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+"-' + key + '"; '
    + '$m=New-Object Threading.Mutex($false,$name); $owned=$false; try { '
    + 'try {$owned=$m.WaitOne(0)} catch [Threading.AbandonedMutexException] {$owned=$true}; '
    + 'if(-not $owned){throw "Exit the Fuli tray and close other updaters before updating."}; '
    + '[Console]::WriteLine("FULI_UPDATE_LOCKED"); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null '
    + '} finally {if($owned){$m.ReleaseMutex()};$m.Dispose()}';
  const child = spawn(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false;
  const completion = new Promise(resolve => { child.once('close', code => { closed = true; resolve(code); }); });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out acquiring the Windows tray lock.')); }, 15000);
    const fail = () => { clearTimeout(timer); reject(new Error('Exit the Fuli tray and close other updaters before updating.')); };
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
