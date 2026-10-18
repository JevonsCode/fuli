import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { stopOwnedProcess } from '../src/native-runtime/runtime.js';
import { assertMacNativePortFree } from '../src/native-runtime/macos-ports.js';
test('native stop waits for the Java-style child after its launcher exits', { skip: process.platform !== 'darwin' }, async () => {
  const child = "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),500));require('node:net').createServer(s=>s.destroy()).listen(0,'127.0.0.1',function(){console.log(this.address().port)})";
  const launcher = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio:'inherit'})`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [data] = await once(launcher.stdout, 'data'); const port = Number(String(data).trim());
    await stopOwnedProcess(launcher.pid);
    await assertMacNativePortFree(port);
  } finally { try { process.kill(-launcher.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
});
