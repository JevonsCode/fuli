import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import test from 'node:test';
import { waitForTcp } from '../src/native-runtime/runtime.js';
test('a dead launcher fails promptly even when an unrelated listener answers', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']);
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(waitForTcp('127.0.0.1', server.address().port, { pid: dead.pid }), /exited|process/i); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
