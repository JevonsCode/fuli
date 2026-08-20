import { execFile } from 'node:child_process';
import { readFile, readdir, lstat, statfs } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';

import { inspectContainerRuntime } from '../setup/container-runtime.js';
import { readJsonFile } from '../storage/json-file.js';

const COMPOSE_PROJECT = 'fuli-graphiti';
const DISK_CACHE_MS = 60_000;
const PROCESS_TIMEOUT_MS = 8_000;
const CONTAINER_LABELS = Object.freeze({
  'personal-provider': 'Personal Provider',
  'personal-neo4j': 'Personal Neo4j',
  'workspace-provider': 'Workspace Provider',
  'workspace-neo4j': 'Workspace Neo4j'
});

export function createResourceMonitor({
  dataDir,
  packageRoot,
  now = () => new Date(),
  processMemory = () => process.memoryUsage(),
  hostMemory = null,
  platform = process.platform,
  runtimeMode = 'container',
  nativeProcessStatePath = null,
  nativePersonalDir = null,
  nativeWorkspaceDir = null,
  readJson = (path) => readJsonFile(path, null),
  readText = readOptionalText,
  containerRuntime = null,
  inspectRuntime = inspectContainerRuntime,
  run = runCommand,
  directorySize = allocatedDirectorySize,
  filesystemStats = hostFilesystemStats
}) {
  let resolvedRuntime = containerRuntime;
  let diskCache = null;
  let hostMemoryCache = null;

  async function sample() {
    const sampledAt = now().toISOString();
    const runtime = runtimeMode === 'container'
      ? (resolvedRuntime ??= inspectRuntime())
      : null;
    const managedMemory = runtimeMode === 'native'
      ? await nativeMemory({
          nativeProcessStatePath,
          nativePersonalDir,
          nativeWorkspaceDir,
          readJson,
          readText,
          run
        })
      : await containerMemory(runtime, run);
    const localMemory = processMemory();
    const host = hostMemory
      ? await hostMemory()
      : await cachedHostMemory({ platform, run, now, cache: hostMemoryCache });
    if (!hostMemory) hostMemoryCache = host.cache;
    const disk = await diskSample({
      runtime,
      run,
      dataDir,
      packageRoot,
      directorySize,
      filesystemStats,
      runtimeMode,
      now,
      cache: diskCache
    });
    diskCache = disk.cache;

    const memoryComponents = [{
      id: 'console',
      label: 'Management service',
      kind: 'process',
      status: 'ready',
      bytes: localMemory.rss
    }, ...managedMemory.components];
    return {
      sampledAt,
      status: managedMemory.complete && disk.value.complete ? 'ready' : 'partial',
      memory: {
        usedBytes: sumBytes(memoryComponents),
        hostTotalBytes: host.value?.totalBytes ?? host.totalBytes,
        hostFreeBytes: host.value?.freeBytes ?? host.freeBytes,
        complete: managedMemory.complete,
        components: memoryComponents
      },
      disk: disk.value,
      exclusions: runtimeMode === 'native'
        ? ['browser-tab-memory']
        : ['browser-tab-memory', 'shared-container-vm-overhead']
    };
  }

  return { sample };
}

async function cachedHostMemory({ platform, run, now, cache }) {
  const timestamp = now().getTime();
  if (cache && timestamp - cache.timestamp < 4_000) {
    return { value: cache.value, cache };
  }
  const totalBytes = totalmem();
  let freeBytes = freemem();
  if (platform === 'darwin') {
    try {
      freeBytes = parseDarwinAvailableMemory(
        await run('memory_pressure', ['-Q']),
        totalBytes
      ) ?? freeBytes;
    } catch {
      // Fall back to strictly free pages when memory_pressure is unavailable.
    }
  }
  const value = { totalBytes, freeBytes };
  return { value, cache: { timestamp, value } };
}

export function parseDarwinAvailableMemory(output, totalBytes) {
  const match = String(output).match(/memory free percentage:\s*(\d+(?:\.\d+)?)%/i);
  const percentage = Number(match?.[1]);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) return null;
  return Math.round(totalBytes * percentage / 100);
}

async function containerMemory(runtime, run) {
  if (runtime?.status !== 'ready') return { complete: false, components: [] };
  try {
    const containers = await listManagedContainers(runtime, run);
    if (containers.length === 0) return { complete: false, components: [] };
    const output = await runDocker(runtime, [
      'stats', '--no-stream', '--format', '{{.ID}}\t{{.MemUsage}}',
      ...containers.map(({ id }) => id)
    ], run);
    const usage = new Map(parseLines(output).map((line) => {
      const [id, value] = line.split('\t');
      return [id, parseDockerBytes(value.split('/', 1)[0].trim())];
    }));
    return {
      complete: containers.every(({ id }) => usage.has(id)),
      components: containers.flatMap(({ id, service }) => usage.has(id) ? [{
        id: service,
        label: CONTAINER_LABELS[service] ?? service,
        kind: 'container',
        status: 'ready',
        bytes: usage.get(id)
      }] : [])
    };
  } catch {
    return { complete: false, components: [] };
  }
}

async function nativeMemory(input) {
  if (!input.nativeProcessStatePath) return { complete: false, components: [] };
  const state = input.readJson(input.nativeProcessStatePath);
  if (!state || state.mode !== 'native') return { complete: false, components: [] };
  const candidates = [];
  for (const [id, entry] of Object.entries(state.providers ?? {})) {
    if (Number.isInteger(entry?.pid)) {
      candidates.push({
        id: `${id}-provider`,
        label: id === 'personal' ? 'Personal Provider' : 'Workspace Provider',
        kind: 'process',
        pid: entry.pid
      });
    }
  }
  const recordedDatabases = new Set();
  for (const [id, entry] of Object.entries(state.databases ?? {})) {
    if (Number.isInteger(entry?.pid)) {
      recordedDatabases.add(id);
      candidates.push({
        id: `${id}-neo4j`,
        label: id === 'personal' ? 'Personal Neo4j' : 'Workspace Neo4j',
        kind: 'process',
        pid: entry.pid
      });
    }
  }
  for (const [id, root] of [
    ['personal', input.nativePersonalDir],
    ['workspace', input.nativeWorkspaceDir]
  ]) {
    if (!root || recordedDatabases.has(id)) continue;
    const value = await input.readText(join(root, 'run', 'neo4j.pid'));
    const pid = Number(String(value ?? '').trim());
    if (Number.isInteger(pid) && pid > 0) {
      candidates.push({
        id: `${id}-neo4j`,
        label: id === 'personal' ? 'Personal Neo4j' : 'Workspace Neo4j',
        kind: 'process',
        pid
      });
    }
  }
  const components = [];
  let processRows;
  try {
    processRows = parseProcessTable(await input.run('ps', ['-axo', 'pid=,ppid=,rss=']));
  } catch {
    return { complete: false, components };
  }
  const claimed = new Set();
  for (const candidate of candidates) {
    if (!processRows.has(candidate.pid)) return { complete: false, components };
    const pids = processTreePids(candidate.pid, processRows);
    const kib = [...pids].reduce((total, pid) => {
      if (claimed.has(pid)) return total;
      claimed.add(pid);
      return total + processRows.get(pid).rssKib;
    }, 0);
    components.push({
      id: candidate.id,
      label: candidate.label,
      kind: candidate.kind,
      status: 'ready',
      bytes: kib * 1024
    });
  }
  return { complete: true, components };
}

function parseProcessTable(output) {
  const rows = new Map();
  for (const line of parseLines(output)) {
    const [pidText, parentText, rssText] = line.trim().split(/\s+/, 3);
    const pid = Number(pidText);
    const parentPid = Number(parentText);
    const rssKib = Number(rssText);
    if (
      Number.isInteger(pid) && pid > 0 &&
      Number.isInteger(parentPid) && parentPid >= 0 &&
      Number.isFinite(rssKib) && rssKib >= 0
    ) rows.set(pid, { parentPid, rssKib });
  }
  return rows;
}

function processTreePids(rootPid, rows) {
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, row] of rows) {
      if (!selected.has(pid) && selected.has(row.parentPid)) {
        selected.add(pid);
        changed = true;
      }
    }
  }
  return selected;
}

async function diskSample(input) {
  const timestamp = input.now().getTime();
  if (input.cache && timestamp - input.cache.timestamp < DISK_CACHE_MS) {
    return { value: input.cache.value, cache: input.cache };
  }
  const [applicationBytes, localDataBytes, filesystem, runtimeDisk] = await Promise.all([
    input.directorySize(input.packageRoot),
    input.directorySize(input.dataDir),
    input.filesystemStats(input.dataDir),
    input.runtimeMode === 'native'
      ? Promise.resolve({ complete: true, components: [], temporaryBytes: null })
      : dockerDisk(input.runtime, input.run)
  ]);
  const components = [
    diskComponent('application', 'Application files', applicationBytes),
    diskComponent('localData', 'Local runtime data', localDataBytes),
    ...runtimeDisk.components
  ].filter(Boolean);
  const value = {
    usedBytes: sumBytes(components),
    hostTotalBytes: filesystem.totalBytes,
    hostFreeBytes: filesystem.freeBytes,
    complete: runtimeDisk.complete && Number.isFinite(filesystem.totalBytes) &&
      Number.isFinite(filesystem.freeBytes),
    measuredAt: input.now().toISOString(),
    temporaryBytes: runtimeDisk.temporaryBytes,
    components
  };
  return { value, cache: { timestamp, value } };
}

async function dockerDisk(runtime, run) {
  if (runtime?.status !== 'ready') {
    return { complete: false, components: [], temporaryBytes: null };
  }
  try {
    const containers = await listManagedContainers(runtime, run);
    if (containers.length === 0) {
      return { complete: false, components: [], temporaryBytes: null };
    }
    const inspectOutput = await runDocker(runtime, [
      'inspect', '--size', '--format', '{{.Id}}\t{{.SizeRw}}\t{{.Image}}',
      ...containers.map(({ id }) => id)
    ], run);
    const inspected = parseLines(inspectOutput).map((line) => {
      const [id, writable, imageId] = line.split('\t');
      return { id, writableBytes: nonNegativeNumber(writable), imageId };
    });
    if (
      inspected.length !== containers.length ||
      inspected.some(({ id, imageId }) => !id || !imageId)
    ) {
      throw new TypeError('Docker container disk metrics are incomplete');
    }
    const imageIds = [...new Set(inspected.map(({ imageId }) => imageId).filter(Boolean))];
    const imageOutput = imageIds.length === 0 ? '' : await runDocker(runtime, [
      'image', 'inspect', '--format', '{{.Id}}\t{{.Size}}', ...imageIds
    ], run);
    const imageSizes = new Map(parseLines(imageOutput).map((line) => {
      const [id, value] = line.split('\t');
      return [id, nonNegativeNumber(value)];
    }));
    if (imageIds.some((id) => !imageSizes.has(id))) {
      throw new TypeError('Docker image disk metrics are incomplete');
    }
    const imageBytes = imageIds.reduce((total, id) => total + imageSizes.get(id), 0);
    const writableBytes = inspected.reduce(
      (total, item) => total + item.writableBytes,
      0
    );
    const volumeUsage = await managedVolumeUsage(runtime, containers, run);
    return {
      complete: true,
      temporaryBytes: volumeUsage.temporaryBytes,
      components: [
        diskComponent('containerImages', 'Container images', imageBytes),
        diskComponent('containerWritable', 'Container writable data', writableBytes),
        diskComponent('neo4jData', 'Neo4j data', volumeUsage.dataBytes),
        diskComponent('neo4jLogs', 'Neo4j logs', volumeUsage.logBytes)
      ].filter(Boolean)
    };
  } catch {
    return { complete: false, components: [], temporaryBytes: null };
  }
}

async function managedVolumeUsage(runtime, containers, run) {
  let dataBytes = 0;
  let logBytes = 0;
  let temporaryBytes = 0;
  const neo4jContainers = containers.filter(({ service }) => service.endsWith('-neo4j'));
  if (neo4jContainers.length === 0) {
    throw new TypeError('No managed Neo4j container was available');
  }
  for (const container of neo4jContainers) {
    const output = await runDocker(runtime, [
      'exec', container.id, 'du', '-sk', '/data', '/logs', '/tmp'
    ], run);
    const usage = new Map();
    for (const line of parseLines(output)) {
      const [kib, path] = line.trim().split(/\s+/, 2);
      if (['/data', '/logs', '/tmp'].includes(path)) {
        usage.set(path, nonNegativeNumber(kib) * 1024);
      }
    }
    if (['/data', '/logs', '/tmp'].some((path) => !usage.has(path))) {
      throw new TypeError('Neo4j volume disk metrics are incomplete');
    }
    dataBytes += usage.get('/data');
    logBytes += usage.get('/logs');
    temporaryBytes += usage.get('/tmp');
  }
  return { dataBytes, logBytes, temporaryBytes };
}

async function listManagedContainers(runtime, run) {
  const output = await runDocker(runtime, [
    'ps', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
    '--format', '{{.ID}}\t{{.Label "com.docker.compose.service"}}'
  ], run);
  return parseLines(output).flatMap((line) => {
    const [id, service] = line.split('\t');
    return id && service && Object.hasOwn(CONTAINER_LABELS, service)
      ? [{ id, service }]
      : [];
  });
}

function runDocker(runtime, args, run) {
  return run(runtime.dockerCommand, args, { env: runtime.dockerEnvironment });
}

export async function allocatedDirectorySize(root) {
  if (typeof root !== 'string' || !root) return 0;
  let total = 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await allocatedDirectorySize(path);
      continue;
    }
    try {
      const stats = await lstat(path);
      total += Number.isFinite(stats.blocks) ? stats.blocks * 512 : stats.size;
    } catch {
      // Files may be replaced while the snapshot is being collected.
    }
  }
  return total;
}

async function hostFilesystemStats(path) {
  try {
    const stats = await statfs(path, { bigint: true });
    return {
      totalBytes: Number(stats.blocks * stats.bsize),
      freeBytes: Number(stats.bavail * stats.bsize)
    };
  } catch {
    return { totalBytes: null, freeBytes: null };
  }
}

function runCommand(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      env,
      timeout: PROCESS_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function parseDockerBytes(value) {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgtp]?i?b)$/i.exec(String(value).trim());
  if (!match) throw new TypeError(`Unsupported Docker byte value: ${value}`);
  const unit = match[2].toLowerCase();
  const powers = { b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4,
    pb: 5, pib: 5 };
  const base = unit.includes('i') ? 1024 : 1000;
  return Math.round(Number(match[1]) * (base ** powers[unit]));
}

function diskComponent(id, label, bytes) {
  return Number.isFinite(bytes) && bytes >= 0
    ? { id, label, status: 'ready', bytes }
    : null;
}

function sumBytes(components) {
  return components.reduce((total, component) => total + component.bytes, 0);
}

function nonNegativeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`Expected a non-negative number, received: ${value}`);
  }
  return number;
}

function parseLines(value) {
  return String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function readOptionalText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
