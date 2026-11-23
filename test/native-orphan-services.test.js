import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stopOrphanedServices } from '../src/native-runtime/orphan-services.js';

// A killed start left this data directory's graph service on its port with
// `processes.json` emptied, and every later start said the port was in use.
function folders(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'fuli-orphans-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const instanceDir = path.join(root, 'native', 'personal');
  const elsewhere = path.join(root, 'someone-else');
  mkdirSync(path.join(instanceDir, 'run'), { recursive: true });
  mkdirSync(elsewhere);
  return { instanceDir, elsewhere };
}

function world({ listeners, cwd, groups }) {
  const stopped = [];
  const recorded = [];
  return { stopped, recorded, options: {
    listeners: async (port) => listeners[port] ?? [],
    cwdOf: async (pid) => cwd[pid] ?? null,
    groupOf: async (pid) => groups[pid] ?? pid,
    stop: async (group) => { stopped.push(group); },
    record: (event) => recorded.push(event)
  } };
}

test('a graph service of this data directory that holds its port is ended, its group at once, and recorded', async (t) => {
  const { instanceDir } = folders(t);
  const w = world({ listeners: { 7687: [501], 7474: [501] }, cwd: { 500: instanceDir, 501: path.join(instanceDir, 'run') },
    groups: { 501: 500 } });
  const ended = await stopOrphanedServices({ instanceDir, ports: [7687], ...w.options });
  assert.deepEqual(ended, [{ port: 7687, pid: 501, group: 500 }]);
  assert.deepEqual(w.stopped, [500]);
  assert.deepEqual(w.recorded, [{ component: 'native-runtime', operation: 'native.orphan', outcome: 'stopped',
    code: 'orphaned_graph_service', port: 7687, pid: 501 }]);
});

test('anything else on the port is left untouched for the start to report', async (t) => {
  const { instanceDir, elsewhere } = folders(t);
  const cases = [
    // Another program, running elsewhere.
    { listeners: { 7687: [601] }, cwd: { 601: elsewhere }, groups: {} },
    // Runs in the instance folder, but its group belongs to something that does not.
    { listeners: { 7687: [602] }, cwd: { 602: instanceDir, 600: elsewhere }, groups: { 602: 600 } },
    // More than one listener: not one service of this data directory.
    { listeners: { 7687: [603, 604] }, cwd: { 603: instanceDir, 604: instanceDir }, groups: {} },
    // Its working directory cannot be read.
    { listeners: { 7687: [605] }, cwd: {}, groups: {} }
  ];
  for (const shape of cases) {
    const w = world(shape);
    assert.deepEqual(await stopOrphanedServices({ instanceDir, ports: [7687], ...w.options }), []);
    assert.deepEqual(w.stopped, []);
    assert.deepEqual(w.recorded, []);
  }
});

test('a folder beside the instance folder whose name starts the same is not inside it', async (t) => {
  const { instanceDir } = folders(t);
  const lookalike = `${instanceDir}-old`;
  mkdirSync(lookalike);
  const w = world({ listeners: { 7687: [701] }, cwd: { 701: lookalike }, groups: {} });
  assert.deepEqual(await stopOrphanedServices({ instanceDir, ports: [7687], ...w.options }), []);
});
