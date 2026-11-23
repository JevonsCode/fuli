import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runTrayAction } from '../src/desktop/desktop-controller.js';
import { endOrphanedServices, findOrphanedServices, orphanedServicesError } from '../src/native-runtime/orphan-services.js';

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

function world({ listeners, cwd = {}, commands = {}, groups = {} }) {
  return {
    listeners: async (port) => listeners[port] ?? [],
    cwdOf: async (pid) => cwd[pid] ?? null,
    commandOf: async (pid) => commands[pid] ?? null,
    groupOf: async (pid) => groups[pid] ?? pid
  };
}

test('a graph service of this data directory on its port is found by where it runs, with its command', async (t) => {
  const { instanceDir } = folders(t);
  const found = await findOrphanedServices({ instanceDir, ports: [7687, 7474], ...world({
    listeners: { 7687: [501], 7474: [501] }, cwd: { 500: instanceDir, 501: path.join(instanceDir, 'run') },
    commands: { 501: '/opt/java/bin/java -cp neo4j.jar org.neo4j.server.CommunityEntryPoint' }, groups: { 501: 500 } }) });
  assert.deepEqual(found, [{ port: 7687, pid: 501, group: 500, command: 'java' },
    { port: 7474, pid: 501, group: 500, command: 'java' }]);
});

// The reviewer's suggestion: read the command line (`ps -o command=`), for a service whose working
// directory cannot be read.
test('one whose working directory cannot be read is found by its command line naming the instance folder', async (t) => {
  const { instanceDir } = folders(t);
  const found = await findOrphanedServices({ instanceDir, ports: [8001], ...world({
    listeners: { 8001: [601] }, commands: { 601: `/usr/bin/python3 -m fuli_graph.server --home ${instanceDir}` } }) });
  assert.deepEqual(found.map((service) => service.pid), [601]);
});

test('anything else on the port is not this data directory\'s and is left for the start to report', async (t) => {
  const { instanceDir, elsewhere } = folders(t);
  const cases = [
    { listeners: { 7687: [701] }, cwd: { 701: elsewhere }, commands: { 701: '/usr/bin/other-program' } },
    // Runs in the instance folder, but its group's leader is something else.
    { listeners: { 7687: [702] }, cwd: { 702: instanceDir, 700: elsewhere }, groups: { 702: 700 } },
    // More than one listener: not one service of this data directory.
    { listeners: { 7687: [703, 704] }, cwd: { 703: instanceDir, 704: instanceDir } },
    // A folder beside the instance folder whose name starts the same.
    { listeners: { 7687: [705] }, commands: { 705: `/usr/bin/java -Dhome=${instanceDir}-old` } },
    // Nothing can be read about it.
    { listeners: { 7687: [706] } }
  ];
  for (const shape of cases) {
    assert.deepEqual(await findOrphanedServices({ instanceDir, ports: [7687], ...world(shape) }), [], JSON.stringify(shape));
  }
});

test('the start says what holds the port, in both languages, with one action to end it and start', () => {
  const error = orphanedServicesError([{ port: 7687, pid: 501, group: 500, command: 'java' }]);
  assert.equal(error.code, 'orphaned_graph_service');
  assert.deepEqual(error.startupFailure, { code: 'orphaned_graph_service', action: 'end-orphans-start',
    services: [{ port: 7687, pid: 501, command: 'java' }] });
  assert.match(error.message, /占着端口 7687.*结束它并启动.*fuli start --end-orphaned-services/s);
  assert.match(error.message, /End it and start/);
});

test('ending them stops each process group once and records each port in the diagnostics', async () => {
  const stopped = [];
  const recorded = [];
  await endOrphanedServices([{ port: 7687, pid: 501, group: 500 }, { port: 7474, pid: 501, group: 500 }],
    { stop: async (group) => stopped.push(group), record: (event) => recorded.push(event) });
  assert.deepEqual(stopped, [500]);
  assert.deepEqual(recorded.map((event) => [event.code, event.port]),
    [['orphaned_graph_service', 7687], ['orphaned_graph_service', 7474]]);
});

// 「结束它并启动」 in the desktop app: the same as `fuli start --end-orphaned-services`, then open.
test('the desktop app\'s 「结束它并启动」 starts with the choice to end the lost service, then opens', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fuli-orphans-app-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const invoked = [];
  let running = false;
  const result = await runTrayAction('end-orphans-start', { dataDir }, {
    runCli: async (_context, args) => {
      invoked.push(args.filter((arg) => arg !== '--data-dir' && arg !== dataDir).join(' '));
      if (args[0] === 'status') return { code: running ? 0 : 1, stdout: JSON.stringify({ status: running ? 'running' : 'stopped' }) };
      if (args[0] === 'start') running = true;
      return { code: 0, stdout: '', stderr: '' };
    },
    portBlocked: async () => false
  });
  assert.equal(result.ok, true, result.error);
  assert.ok(invoked.includes('start --end-orphaned-services'));
  assert.ok(invoked.includes('open'));
});
