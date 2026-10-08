import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from '../acceptance/handoff-live/process.js';

test('an unresponsive CLI has a bounded timeout', { timeout: 12_000 }, async () => {
  const started = Date.now();
  const result = await run(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { timeoutMs: 200 });
  assert.equal(result.error, 'CLI timed out');
  assert.ok(Date.now() - started < 9000);
});

test('CLI output overflow is truncated and terminates the process', { timeout: 12_000 }, async () => {
  const result = await run(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"], { timeoutMs: 5000, maxOutputBytes: 1000 });
  assert.equal(result.stdout.length, 1000);
  assert.equal(result.error, 'CLI output limit exceeded');
});

test('POSIX cleanup kills descendants even when the parent exits on SIGTERM', {
  skip: process.platform === 'win32', timeout: 12_000
}, async () => {
  const childSource = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const source = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)`;
  const result = await run(process.execPath, ['-e', source], { timeoutMs: 700 });
  const childPid = Number(result.stdout.trim());
  assert.ok(childPid > 0);
  let alive = false;
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    try {
      process.kill(childPid, 0);
      // Some container init processes reap slowly; a zombie is already stopped.
      alive = process.platform !== 'linux' || !/\) Z /.test(readFileSync(`/proc/${childPid}/stat`, 'utf8'));
    } catch {}
    assert.equal(alive, false);
  } finally {
    if (alive) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
  }
});
