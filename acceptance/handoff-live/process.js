import { spawn } from 'node:child_process';

// Bound real CLI runs and their output; never include commands/credentials in errors.
export function run(command, args, { cwd, env = process.env, timeoutMs = 300_000, maxOutputBytes = 8_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = '', failure, settled = false, hardTimer;
    const finish = code => {
      if (settled) return;
      settled = true;
      // Each bounded run owns its process group. A parent can close its pipes
      // on success, failure or a signal before its descendants exit.
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
      clearTimeout(timer); clearTimeout(hardTimer);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolve({ code, stdout: stdout.toString('utf8'), stderr, error: failure });
    };
    const stop = (message) => {
      if (failure || settled) return;
      failure = message;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.unref();
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      }
      hardTimer = setTimeout(() => {
        if (process.platform === 'win32') child.kill();
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        finish(null);
      }, 2000);
    };
    const timer = setTimeout(() => stop('CLI timed out'), timeoutMs);
    child.stdout.on('data', chunk => {
      if (failure) return;
      const available = maxOutputBytes - stdout.length;
      stdout = Buffer.concat([stdout, chunk.subarray(0, available)]);
      if (chunk.length > available) stop('CLI output limit exceeded');
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
    child.on('error', error => { clearTimeout(timer); clearTimeout(hardTimer); settled = true; reject(error); });
    child.on('close', finish);
  });
}
