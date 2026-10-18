import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { assertMacNativePortFree, assertMacNativePortOwner } from '../src/native-runtime/macos-ports.js';

test('macOS checks actual listener ownership and never accepts a foreign PID', { skip: process.platform !== 'darwin' }, async () => {
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(assertMacNativePortFree(port), /already in use/);
    await assertMacNativePortOwner({ pid: process.pid }, port);
    await assert.rejects(assertMacNativePortOwner({ pid: 99999999 }, port), /ownership/i);
    assert.equal(server.listening, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
  await assertMacNativePortFree(port);
  await assert.rejects(assertMacNativePortOwner({ pid: process.pid }, port), /ownership/i);
});
test('invalid port is rejected before inspection', async () => {
  await assert.rejects(assertMacNativePortFree(0), /port/i);
  await assert.rejects(assertMacNativePortOwner({}, 1), /identity|PID/i);
});

test('a detached launcher owns the Java-style child listener in its process group', { skip: process.platform !== 'darwin' }, async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const childCode = "require('node:net').createServer(s=>s.destroy()).listen(0,'127.0.0.1',function(){console.log(this.address().port)})";
  const launcher = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'inherit'})`], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const [chunk] = await once(launcher.stdout, 'data');
    const port = Number(String(chunk).trim());
    await assertMacNativePortOwner({ pid: launcher.pid }, port);
  } finally {
    const exited = once(launcher, 'exit'); process.kill(-launcher.pid, 'SIGTERM'); await exited;
  }
});
