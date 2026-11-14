import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { consoleLeftRunning } from '../src/desktop/failed-update-recovery.js';

// The OS process list is a fake: no real process is listed or waited for.

function clock() {
  let time = 0;
  return { now: () => time, wait: async ms => { time += ms; } };
}

test('a console the failed start left is waited for, and nothing is said once it has ended', async () => {
  const lists = [[{ pid: 4242 }], [{ pid: 4242 }], []];
  const scanned = [];
  const left = await consoleLeftRunning('/synthetic/data', { ...clock(),
    scan: async path => { scanned.push(path); return lists.shift(); } });
  assert.equal(left, null);
  assert.equal(scanned.length, 3);
  assert.equal(scanned[0], join(resolve('/synthetic/data'), 'graph-runtime.json'));
});

test('a console that does not end in time, or a list that cannot be read, is the reason nothing moves', async () => {
  assert.equal(await consoleLeftRunning('/synthetic/data', { ...clock(), scan: async () => [{ pid: 4242 }, { pid: 4243 }] }),
    'a FULI console still runs (process 4242, 4243)');
  assert.equal(await consoleLeftRunning('/synthetic/data', { ...clock(), scan: async () => null }),
    'the running FULI processes could not be listed');
});
