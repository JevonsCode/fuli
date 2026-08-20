import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createResourceMonitor,
  parseDarwinAvailableMemory,
  parseDockerBytes
} from '../src/system/resource-monitor.js';

test('resource monitor combines the console, managed containers, images, and Neo4j volumes', async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'ps') {
      return 'provider-id\tpersonal-provider\nneo4j-id\tpersonal-neo4j\n';
    }
    if (args[0] === 'stats') {
      return 'provider-id\t128MiB / 4GiB\nneo4j-id\t900MiB / 4GiB\n';
    }
    if (args[0] === 'inspect') {
      return 'provider-id\t0\timage-provider\nneo4j-id\t104857600\timage-neo4j\n';
    }
    if (args[0] === 'image') {
      return 'image-provider\t268435456\nimage-neo4j\t629145600\n';
    }
    if (args[0] === 'exec') {
      return '512000\t/data\n6144\t/logs\n819200\t/tmp\n';
    }
    throw new Error(`Unexpected Docker invocation: ${args.join(' ')}`);
  };
  const monitor = createResourceMonitor({
    dataDir: '/data',
    packageRoot: '/package',
    now: () => new Date('2026-08-01T10:00:00.000Z'),
    processMemory: () => ({ rss: 40 * 1024 * 1024 }),
    hostMemory: () => ({ totalBytes: 16_000_000_000, freeBytes: 8_000_000_000 }),
    containerRuntime: {
      status: 'ready',
      dockerCommand: 'docker',
      dockerEnvironment: {}
    },
    run,
    directorySize: async (path) => path === '/package' ? 300 * 1024 * 1024 : 40 * 1024 * 1024,
    filesystemStats: async () => ({ totalBytes: 500_000_000_000, freeBytes: 200_000_000_000 })
  });

  const first = await monitor.sample();
  const second = await monitor.sample();

  assert.equal(first.status, 'ready');
  assert.equal(first.memory.usedBytes, (40 + 128 + 900) * 1024 * 1024);
  assert.equal(first.disk.temporaryBytes, 819200 * 1024);
  assert.equal(first.disk.components.find(({ id }) => id === 'neo4jData').bytes, 512000 * 1024);
  assert.equal(first.disk.usedBytes, first.disk.components.reduce(
    (total, component) => total + component.bytes,
    0
  ));
  assert.equal(second.disk.measuredAt, first.disk.measuredAt);
  assert.equal(calls.filter(([command]) => command === 'inspect').length, 1);
  assert.equal(calls.filter(([command]) => command === 'stats').length, 2);
});

test('Docker byte values use the unit base reported by Docker', () => {
  assert.equal(parseDockerBytes('1.5MiB'), 1.5 * 1024 * 1024);
  assert.equal(parseDockerBytes('1.5MB'), 1_500_000);
});

test('macOS available memory follows the memory-pressure percentage', () => {
  assert.equal(parseDarwinAvailableMemory(
    'System-wide memory free percentage: 30%\n',
    16 * 1024 ** 3
  ), Math.round(16 * 1024 ** 3 * 0.3));
  assert.equal(parseDarwinAvailableMemory('unavailable', 16 * 1024 ** 3), null);
});

test('macOS resource samples cache the pressure-based available-memory reading', async () => {
  let pressureCalls = 0;
  const monitor = createResourceMonitor({
    dataDir: '/data',
    packageRoot: '/package',
    platform: 'darwin',
    now: () => new Date('2026-08-18T12:00:00.000Z'),
    processMemory: () => ({ rss: 10 }),
    containerRuntime: { status: 'missing' },
    run: async (command, args) => {
      assert.equal(command, 'memory_pressure');
      assert.deepEqual(args, ['-Q']);
      pressureCalls += 1;
      return 'System-wide memory free percentage: 25%\n';
    },
    directorySize: async () => 0,
    filesystemStats: async () => ({ totalBytes: 100, freeBytes: 50 })
  });

  const first = await monitor.sample();
  const second = await monitor.sample();

  assert.equal(first.memory.hostFreeBytes, Math.round(first.memory.hostTotalBytes * 0.25));
  assert.equal(second.memory.hostFreeBytes, first.memory.hostFreeBytes);
  assert.equal(pressureCalls, 1);
});

test('resource monitor marks unavailable container and filesystem measurements as partial', async () => {
  const monitor = createResourceMonitor({
    dataDir: '/missing-data',
    packageRoot: '/package',
    processMemory: () => ({ rss: 10 }),
    hostMemory: () => ({ totalBytes: 100, freeBytes: 50 }),
    containerRuntime: { status: 'missing' },
    directorySize: async () => 0,
    filesystemStats: async () => ({ totalBytes: null, freeBytes: null })
  });

  const snapshot = await monitor.sample();
  assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.memory.complete, false);
  assert.equal(snapshot.disk.complete, false);
});

test('resource monitor does not replace malformed Docker disk metrics with zero', async () => {
  const run = async (_command, args) => {
    if (args[0] === 'ps') return 'provider-id\tpersonal-provider\nneo4j-id\tpersonal-neo4j\n';
    if (args[0] === 'stats') return 'provider-id\t1MiB / 4GiB\nneo4j-id\t1MiB / 4GiB\n';
    if (args[0] === 'inspect') return 'provider-id\tnull\timage-provider\n';
    throw new Error(`Unexpected Docker invocation: ${args.join(' ')}`);
  };
  const monitor = createResourceMonitor({
    dataDir: '/data',
    packageRoot: '/package',
    hostMemory: () => ({ totalBytes: 100, freeBytes: 50 }),
    containerRuntime: {
      status: 'ready',
      dockerCommand: 'docker',
      dockerEnvironment: {}
    },
    run,
    directorySize: async () => 0,
    filesystemStats: async () => ({ totalBytes: 100, freeBytes: 50 })
  });

  const snapshot = await monitor.sample();

  assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.memory.complete, true);
  assert.equal(snapshot.disk.complete, false);
  assert.equal(snapshot.disk.components.some(({ id }) => id === 'containerWritable'), false);
});

test('native resource monitor measures owned Provider and Neo4j processes without Docker',
  async () => {
    const processState = {
      version: 1,
      mode: 'native',
      providers: {
        personal: { pid: 4100, command: '/native/python' },
        workspace: { pid: 4101, command: '/native/python' }
      }
    };
    const pidFiles = new Map([
      ['/native/personal/run/neo4j.pid', '4200\n'],
      ['/native/workspace/run/neo4j.pid', '4201\n']
    ]);
    const processTable = [
      '4100 1 51200',
      '4101 1 25600',
      '4200 1 1024',
      '4201 1 1024',
      '4300 4200 204800',
      '4301 4201 102400'
    ].join('\n');
    const monitor = createResourceMonitor({
      dataDir: '/data',
      packageRoot: '/package',
      runtimeMode: 'native',
      nativeProcessStatePath: '/native/processes.json',
      nativePersonalDir: '/native/personal',
      nativeWorkspaceDir: '/native/workspace',
      readJson: () => processState,
      readText: async (path) => pidFiles.get(path) ?? null,
      processMemory: () => ({ rss: 10 * 1024 * 1024 }),
      hostMemory: () => ({ totalBytes: 1000, freeBytes: 500 }),
      inspectRuntime() {
        throw new Error('Docker must not be inspected in native mode');
      },
      run: async (command, args) => {
        assert.equal(command, 'ps');
        assert.deepEqual(args, ['-axo', 'pid=,ppid=,rss=']);
        return processTable;
      },
      directorySize: async () => 0,
      filesystemStats: async () => ({ totalBytes: 1000, freeBytes: 500 })
    });

    const snapshot = await monitor.sample();

    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.memory.usedBytes,
      (10 * 1024 + 51_200 + 25_600 + 1_024 + 1_024 + 204_800 + 102_400) * 1024);
    assert.deepEqual(snapshot.memory.components.slice(1).map(({ id, kind }) => ({ id, kind })), [
      { id: 'personal-provider', kind: 'process' },
      { id: 'workspace-provider', kind: 'process' },
      { id: 'personal-neo4j', kind: 'process' },
      { id: 'workspace-neo4j', kind: 'process' }
    ]);
    assert.deepEqual(snapshot.exclusions, ['browser-tab-memory']);
    assert.equal(snapshot.disk.complete, true);
  });
