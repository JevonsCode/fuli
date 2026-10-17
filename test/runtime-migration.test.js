import assert from 'node:assert/strict';
import test from 'node:test';

import { migrateContainerGraphToNative } from '../src/backup/runtime-migration.js';
import { censusDifferences, censusFromRows, parsePlainCensusRows } from '../src/backup/graph-census.js';

const census = (nodes, entity = nodes) => ({
  nodes, relationships: 4, labels: { Entity: entity }, types: { RELATES_TO: 4 }
});

function harness({ mode = 'container', running = true, stop = { status: 'stopped' }, targetCensus = census(5),
  failImport = false, failRollback = false, failCheck = false } = {}) {
  const events = [];
  let settingsMode = mode;
  let consoleUp = running;
  const adapter = (kind) => ({
    instances: ['personal'],
    async census(instance) {
      events.push(`census:${kind}:${instance}`);
      return kind === 'container' ? census(5) : targetCensus;
    }
  });
  const ports = {
    runtimeMode: () => settingsMode,
    async checkNative() { events.push('check-native'); if (failCheck) throw new Error('no native assets'); },
    async consoleRunning() { return consoleUp; },
    async stopRuntime() { events.push('stop'); consoleUp = false; return stop; },
    async startRuntime() { events.push('start'); consoleUp = true; },
    async createAdapter(kind) { events.push(`adapter:${kind}`); return adapter(kind); },
    async exportGraph({ outputDir }) { events.push(`export:${outputDir.replaceAll('\\', '/')}`); },
    async importGraph() { events.push('import'); if (failImport) throw new Error('synthetic load failure'); },
    async setupRuntime(target) {
      events.push(`setup:${target}`);
      if (target === 'container' && failRollback) throw new Error('synthetic container failure');
      settingsMode = target;
      consoleUp = true;
    },
    write: () => {}
  };
  return { events, ports, run: () => migrateContainerGraphToNative({
    backupRoot: '/data/backups/graph', now: () => new Date('2026-10-18T01:00:00.000Z'), ports
  }) };
}

test('a container graph moves to native only after the native census matches', async () => {
  const { events, run } = harness();
  const result = await run();

  assert.equal(result.status, 'migrated');
  assert.equal(result.backupDir.replaceAll('\\', '/'), '/data/backups/graph/container-to-native-2026-10-18T01-00-00-000Z');
  assert.deepEqual(events, [
    'check-native',
    'stop',
    'adapter:container',
    'census:container:personal',
    'export:/data/backups/graph/container-to-native-2026-10-18T01-00-00-000Z',
    'setup:native',
    'stop',
    'adapter:native',
    'import',
    'census:native:personal',
    'start'
  ]);
});

test('a census mismatch switches back to the unchanged container graph', async () => {
  const { events, run } = harness({ targetCensus: census(5, 4) });
  await assert.rejects(run(), (error) => {
    assert.match(error.message, /does not match/);
    assert.match(error.message, /personal labels Entity: 5 → 4/);
    assert.match(error.message, /back on the unchanged container graph/);
    return true;
  });
  // Native graph processes can run without a console, so it always stops first.
  assert.deepEqual(events.slice(-3), ['census:native:personal', 'stop', 'setup:container']);
  assert.equal(events.includes('start'), false);
});

test('an import failure also switches back, and a failed switch-back says so', async () => {
  const back = harness({ failImport: true });
  await assert.rejects(back.run(), /synthetic load failure.*back on the unchanged container graph/s);
  assert.deepEqual(back.events.slice(-3), ['import', 'stop', 'setup:container']);

  const stuck = harness({ failImport: true, failRollback: true });
  await assert.rejects(stuck.run(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /switching back to container mode also failed/);
    assert.match(error.message, /synthetic load failure/);
    assert.match(error.message, /synthetic container failure/);
    assert.match(error.message, /container graph was not changed/);
    return true;
  });
});

test('nothing is stopped or exported when native assets are missing or the console will not stop', async () => {
  const missing = harness({ failCheck: true });
  await assert.rejects(missing.run(), /no native assets/);
  assert.deepEqual(missing.events, ['check-native']);

  const stuck = harness({ stop: { status: 'partial' } });
  await assert.rejects(stuck.run(), /Nothing was changed/);
  assert.deepEqual(stuck.events, ['check-native', 'stop']);
});

test('an export failure leaves the container mode untouched', async () => {
  const { events, ports } = harness();
  ports.exportGraph = async () => { events.push('export'); throw new Error('synthetic dump failure'); };
  await assert.rejects(migrateContainerGraphToNative({ backupRoot: '/b', ports }), /synthetic dump failure/);
  assert.equal(events.some((event) => event.startsWith('setup:')), false);
});

test('a native graph is reported as already native and not touched', async () => {
  const { events, run } = harness({ mode: 'native' });
  assert.deepEqual(await run(), { status: 'already_native' });
  assert.deepEqual(events, []);
});

test('graph census reads cypher-shell plain rows and lists every difference', () => {
  const rows = parsePlainCensusRows('name, count\n"Entity", 5\n"Label \\"quoted\\"", 2\n');
  assert.deepEqual(rows, [['Entity', 5], ['Label "quoted"', 2]]);
  assert.throws(() => parsePlainCensusRows('name, count\nEntity 5'), /could not be read/);

  const source = censusFromRows({
    nodes: [['nodes', 7]], relationships: [['relationships', 4]],
    labels: [['Entity', 5], ['Episodic', 2]], types: [['RELATES_TO', 4]]
  });
  assert.deepEqual(source, { nodes: 7, relationships: 4, labels: { Entity: 5, Episodic: 2 }, types: { RELATES_TO: 4 } });
  assert.deepEqual(censusDifferences(source, source), []);
  assert.deepEqual(censusDifferences(source, { ...source, nodes: 6, labels: { Entity: 5 }, types: { RELATES_TO: 4, NEW: 1 } }), [
    'nodes: 7 → 6', 'labels Episodic: 2 → 0', 'types NEW: 0 → 1'
  ]);
  assert.throws(() => censusFromRows({ nodes: [], relationships: [['relationships', 1]], labels: [], types: [] }), /invalid total/);
});

test('a native setup that fails part-way stops what it started before switching back', async () => {
  const { events, ports, run } = harness();
  const setup = ports.setupRuntime;
  ports.setupRuntime = async (target) => {
    if (target === 'native') { events.push('setup:native'); throw new Error('Provider request failed with 401'); }
    return setup(target);
  };
  await assert.rejects(run(), /401.*back on the unchanged container graph/s);
  assert.deepEqual(events.slice(-3), ['setup:native', 'stop', 'setup:container']);
});
