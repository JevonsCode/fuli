import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { runProcess } from '../src/agent-roundtable/wake.js';

async function waitFor(read) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw new Error('Synthetic child did not reach the expected state');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

for (const [mode, code] of [['cancel', 'cancelled'], ['timeout', 'wake_timeout'], ['output', 'wake_failed']]) {
  test(`${mode} waits for its real process tree to exit before returning`, { timeout: 10_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fuli-process-exit-'));
    const pidFile = join(cwd, 'pids.json');
    const controller = new AbortController();
    let pids = [];
    const script = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
      if (process.argv[2] === 'output') process.stdout.write('x'.repeat(4096));
      setInterval(() => {}, 1000);
    `;
    const result = runProcess(process.execPath, ['-e', script, pidFile, mode], {
      cwd, env: {}, input: '', timeoutMs: mode === 'timeout' ? 1_000 : 30_000,
      maxOutputBytes: 1024, signal: controller.signal,
    }).catch((error) => error);
    try {
      pids = await waitFor(async () => {
        try { return JSON.parse(await readFile(pidFile, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      });
      if (mode === 'cancel') controller.abort('share_withdrawn');
      const error = await result;
      assert.equal(error.code, code);
      assert.equal(error.cleanup, undefined, 'cleanup must be confirmed');
      assert.deepEqual(pids.map(alive), [false, false], 'both owned processes must have exited');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      controller.abort('fixture_cleanup');
      await result;
      // A failing old implementation still has an asynchronous kill in flight.
      await waitFor(() => pids.every((pid) => !alive(pid)));
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

// An idle descendant holding a large resident heap exits measurably later than
// its group leader, so "the leader closed" cannot stand in for "the tree exited".
test('confirmed cleanup waits for a slow-exiting descendant, not only the leader', { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'fuli-process-exit-'));
  const pidFile = join(cwd, 'pids.json');
  const controller = new AbortController();
  let pids = [];
  const descendant = `
    globalThis.held = Buffer.alloc(64 * 1024 * 1024, 1);
    require('node:fs').writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const script = `
    const { spawn } = require('node:child_process');
    const { readFileSync, writeFileSync } = require('node:fs');
    const ready = process.argv[1] + '.descendant';
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, ready], { stdio: 'ignore' });
    const report = setInterval(() => {
      try { readFileSync(ready); } catch { return; }
      clearInterval(report);
      writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
    }, 10);
    setInterval(() => {}, 1000);
  `;
  const result = runProcess(process.execPath, ['-e', script, pidFile], {
    cwd, env: {}, input: '', timeoutMs: 30_000, maxOutputBytes: 1024, signal: controller.signal,
  }).catch((error) => error);
  try {
    pids = await waitFor(async () => {
      try { return JSON.parse(await readFile(pidFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
    // Like the timeout path, kill a tree that has gone idle; an immediate kill
    // can let the descendant finish exiting first by accident.
    await delay(500);
    controller.abort('share_withdrawn');
    const error = await result;
    assert.equal(error.code, 'cancelled');
    assert.equal(error.cleanup, undefined, 'cleanup must be confirmed');
    assert.deepEqual(pids.map(alive), [false, false], 'both owned processes must have exited');
  } finally {
    controller.abort('fixture_cleanup');
    await result;
    await waitFor(() => pids.every((pid) => !alive(pid)));
    await rm(cwd, { recursive: true, force: true });
  }
});
