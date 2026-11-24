import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runTrayAction } from '../src/desktop/desktop-controller.js';
import { reportingStartupFailure } from '../src/local-runtime/startup-failure.js';
import { startupFailureLine } from '../src/local-runtime/startup-failure-line.js';
import { endOrphanedServices, findOrphanedServices, orphanedServicesError, ownGraphDatabase, ownGraphProcess } from '../src/native-runtime/orphan-services.js';

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

test('in the terminal the lost service is said as what happened and the command that ends it, its facts kept for a client', async () => {
  const thrown = orphanedServicesError([{ port: 7687, pid: 501, group: 500, command: 'java' }]);
  await assert.rejects(reportingStartupFailure(async () => { throw thrown; }), (error) => {
    const lines = error.message.split('\n');
    assert.match(lines[0], /^没有启动：.*占着端口 7687/);
    assert.match(lines[1], /^下一步：运行 fuli start --end-orphaned-services/);
    assert.match(lines[3], /^Next: Run `fuli start --end-orphaned-services`/);
    assert.deepEqual(error.startupFailure.services, [{ port: 7687, pid: 501, command: 'java' }]);
    return true;
  });
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

// Review of #1075: the button needs the reason as data, not as words in an error message.
test('a start that stops at a lost service tells the window its reason with the ports and programs', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fuli-orphans-report-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(path.join(dataDir, 'native'));
  writeFileSync(path.join(dataDir, 'graph-runtime.json'), '{}');
  writeFileSync(path.join(dataDir, 'runtime-settings.json'), JSON.stringify({ version: 1, graphRuntimeMode: 'native' }));
  const error = orphanedServicesError([{ port: 7687, pid: 501, group: 500, command: 'java' }]);
  const stderr = `${error.message}\n${startupFailureLine(error)}\n`;
  const result = await runTrayAction('start', { dataDir }, {
    runCli: async (_context, args) => (args[0] === 'status'
      ? { code: 1, stdout: JSON.stringify({ status: 'stopped' }) }
      : { code: 1, stdout: '', stderr }),
    portBlocked: async () => false, otherConsole: () => null, holdAdoption: () => null
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'orphaned_graph_service');
  assert.deepEqual(result.failure.services, [{ port: 7687, pid: 501, command: 'java' }]);
  assert.doesNotMatch(result.error, /FULI_STARTUP_FAILURE/, 'the reason line is not shown as words');
  assert.match(result.error, /结束它并启动/);
});

// A recovery asks the same of a process holding a graph's store (load-recovery.js end-holders), across both instances.
test('a process holding a store is recognised by the same checks, for any of the instance folders, and a stranger in its group is not', async (t) => {
  const { instanceDir, elsewhere } = folders(t);
  const workspace = path.join(path.dirname(instanceDir), 'workspace');
  mkdirSync(workspace);
  const reads = world({ listeners: {}, cwd: { 700: workspace, 710: workspace, 711: elsewhere },
    commands: { 700: '/opt/java/bin/java -cp neo4j.jar', 710: 'java' }, groups: { 710: 711 } });
  assert.deepEqual(await ownGraphProcess({ instanceDirs: [instanceDir, workspace], pid: 700, ...reads }), { pid: 700, group: 700, command: 'java' });
  assert.equal(await ownGraphProcess({ instanceDirs: [instanceDir], pid: 700, ...reads }), null, 'another instance folder does not count');
  assert.equal(await ownGraphProcess({ instanceDirs: [instanceDir, workspace], pid: 710, ...reads }), null, 'its group leader runs elsewhere');
});

// Only a Neo4j FULI started is ever ended for holding a store: a `tail -f` of
// its logs, or a shell whose working directory is the instance folder, is in
// that folder too, and is never taken for the database.
test('a process holding a store counts as this data directory\'s Neo4j only when it and its group leader are the managed Neo4j JVM', async (t) => {
  const { instanceDir, elsewhere } = folders(t);
  const runtimeDir = path.dirname(instanceDir);
  const home = path.join(runtimeDir, 'neo4j-community-5.26.28');
  const jvm = main => `/opt/fuli/java/bin/java -cp ${home}/plugins/*:${home}/conf/*:${home}/lib/* -Dfile.encoding=UTF-8 ${main} --home-dir=${home} --config-dir=${instanceDir}/conf`;
  const reads = world({ listeners: {},
    cwd: { 800: instanceDir, 801: instanceDir, 810: instanceDir, 820: instanceDir, 830: instanceDir, 840: instanceDir, 841: instanceDir },
    commands: {
      800: jvm('org.neo4j.server.startup.Neo4jBoot'), 801: jvm('org.neo4j.server.CommunityEntryPoint'),
      810: `tail -f ${instanceDir}/logs/neo4j.log`,
      820: '-zsh',
      // Named java and in the folder, but no Neo4j main class.
      830: `/usr/bin/java -jar ${instanceDir}/tool.jar`,
      // A Neo4j JVM, but from a Neo4j home FULI does not manage.
      840: jvm('org.neo4j.server.CommunityEntryPoint').replaceAll(home, path.join(elsewhere, 'neo4j-community-5.26.28')),
      841: jvm('org.neo4j.server.CommunityEntryPoint')
    },
    groups: { 801: 800, 841: 820 } });
  const scope = { instanceDirs: [instanceDir], runtimeDir, ...reads };
  assert.deepEqual(await ownGraphDatabase({ ...scope, pid: 801 }), { pid: 801, group: 800, command: 'java' });
  for (const pid of [810, 820, 830, 840]) assert.equal(await ownGraphDatabase({ ...scope, pid }), null, `process ${pid}`);
  assert.equal(await ownGraphDatabase({ ...scope, pid: 841 }), null, 'a Neo4j whose group leader is a shell: the group is not ended');
  // The start's own check is unchanged: a sole listener on its port, recognised by where it runs.
  assert.equal((await ownGraphProcess({ instanceDirs: [instanceDir], pid: 810, ...reads }))?.pid, 810);
});
