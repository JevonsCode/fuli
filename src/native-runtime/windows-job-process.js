import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./windows-job-process.cs', import.meta.url));
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const failed = () => new Error('Owned Windows job did not confirm cleanup');

// A private control channel stays outside ACP stdio. Closing it (including host
// death) stops the job even after the adapter and intermediate parents have exited.
export async function spawnWindowsJobProcess(command, args, { cwd, env, stopTimeoutMs }) {
  const pipeName = 'fuli-owned-job-' + randomUUID();
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen('\\\\.\\pipe\\' + pipeName, resolve); });
  let socket, child, pid, terminal, helperResult, stopping = false, ended = false, controlClosed = false, pending = '';
  let resolveReady, rejectReady, resolveExit;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const snapshots = [];
  const fail = () => {
    rejectReady(failed());
    for (const entry of snapshots.splice(0)) entry.reject(failed());
  };
  const finish = () => {
    if (!helperResult || (socket && !controlClosed)) return;
    resolveExit({ clean: helperResult.code === 0 && !helperResult.signal && terminal?.type === 'closed' });
  };
  server.on('connection', connection => {
    if (socket) { connection.destroy(); return; }
    socket = connection; server.close(); socket.setEncoding('utf8');
    socket.on('error', fail);
    socket.on('data', chunk => {
      pending += chunk;
      if (pending.length > 16_384) { fail(); socket.destroy(); return; }
      let boundary;
      while ((boundary = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
        let value;
        try { value = JSON.parse(line); } catch { fail(); socket.destroy(); return; }
        if (value.type === 'ready' && Number.isInteger(value.pid) && value.pid > 0 && !pid) {
          pid = value.pid; resolveReady(value);
        } else if (value.type === 'snapshot' && Array.isArray(value.pids)) snapshots.shift()?.resolve(value.pids);
        else if (value.type === 'closed' && value.activeProcesses === 0) {
          terminal = value;
          // Release the helper's pending control read before waiting for its exit.
          if (!socket.writableEnded) socket.end();
        }
        else if (value.type === 'error') { terminal = value; fail(); }
        else { fail(); socket.destroy(); return; }
      }
    });
    socket.on('close', () => { controlClosed = true; if (!terminal) fail(); finish(); });
    socket.write(JSON.stringify({ command, args, cwd, env, stopTimeoutMs, skipLaunch: stopping }) + '\n');
  });
  // Configuration is parsed as control-pipe data, never PowerShell source.
  const script = [
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$pipe=$null;$writer=$null;try {",
    // Overlapped mode permits the exit thread to confirm cleanup while the
    // control thread waits for a command; synchronous duplex reads lock writes.
    "$pipe=[System.IO.Pipes.NamedPipeClientStream]::new('.'," + literal(pipeName) + ",[System.IO.Pipes.PipeDirection]::InOut,[System.IO.Pipes.PipeOptions]::Asynchronous)",
    '$pipe.Connect(10000)',
    '$reader=[System.IO.StreamReader]::new($pipe,[System.Text.UTF8Encoding]::new($false))',
    '$writer=[System.IO.StreamWriter]::new($pipe,[System.Text.UTF8Encoding]::new($false));$writer.AutoFlush=$true',
    '$spec=$reader.ReadLine()|ConvertFrom-Json',
    'if($spec.skipLaunch){$writer.WriteLine(\'{"type":"closed","activeProcesses":0}\');exit 0}',
    'Add-Type -Path ' + literal(source),
    "[string[]]$environment=@($spec.env.PSObject.Properties|ForEach-Object{$_.Name+'='+[string]$_.Value})",
    '$result=[FuliJobProcess]::Run($spec.command,[string[]]$spec.args,$spec.cwd,$environment,$reader,$writer,[uint32]$spec.stopTimeoutMs)',
    'exit $result',
    '}catch{if($writer){try{$writer.WriteLine(\'{"type":"error","code":"launch_failed"}\')}catch{}};exit 1}',
    'finally{if($pipe){$pipe.Dispose()}}'
  ].join('\n');
  try {
    const powershell = join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) { server.close(); throw error; }
  child.once('error', fail);
  child.once('close', (code, signal) => {
    ended = true; helperResult = { code, signal }; server.close(); fail();
    // The control pipe can deliver its final buffered acknowledgement after the
    // helper's stdio closes. Wait for both channels before deciding cleanup.
    finish();
  });
  return { get pid() { return pid; }, ready, exited,
    stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
    snapshot: () => {
      if (!socket || ended || stopping || terminal) return Promise.reject(failed());
      return new Promise((resolve, reject) => { snapshots.push({ resolve, reject }); socket.write('snapshot\n'); });
    },
    async stop(timeoutMs = stopTimeoutMs) {
      stopping = true;
      if (socket && !socket.destroyed && !socket.writableEnded) socket.write('stop\n');
      let timer;
      try {
        const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(failed()), timeoutMs); })]);
        if (!result.clean) throw failed();
      } catch (error) {
        // ChildProcess.kill targets this exact helper. Its last job handle closes
        // on death; without a job-empty acknowledgement cleanup remains failure.
        child.kill(); socket?.destroy(); server.close(); throw error;
      } finally { clearTimeout(timer); }
    },
    unref: () => child.unref()
  };
}
