import { execFile } from 'node:child_process';
import { readdir, lstat, statfs } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';

import { inspectContainerRuntime } from '../setup/container-runtime.js';

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
  hostMemory = () => ({ totalBytes: totalmem(), freeBytes: freemem() }),
  containerRuntime = null,
  inspectRuntime = inspectContainerRuntime,
  run = runCommand,
  directorySize = allocatedDirectorySize,
  filesystemStats = hostFilesystemStats
}) {
  let resolvedRuntime = containerRuntime;
  let diskCache = null;

  async function sample() {
    const sampledAt = now().toISOString();
    const runtime = resolvedRuntime ??= inspectRuntime();
    const containers = await containerMemory(runtime, run);
    const localMemory = processMemory();
    const host = hostMemory();
    const disk = await diskSample({
      runtime,
      run,
      dataDir,
      packageRoot,
      directorySize,
      filesystemStats,
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
    }, ...containers.components];
    return {
      sampledAt,
      status: containers.complete && disk.value.complete ? 'ready' : 'partial',
      memory: {
        usedBytes: sumBytes(memoryComponents),
        hostTotalBytes: host.totalBytes,
        hostFreeBytes: host.freeBytes,
        complete: containers.complete,
        components: memoryComponents
      },
      disk: disk.value,
      exclusions: ['browser-tab-memory', 'shared-container-vm-overhead']
    };
  }

  return { sample };
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

async function diskSample(input) {
  const timestamp = input.now().getTime();
  if (input.cache && timestamp - input.cache.timestamp < DISK_CACHE_MS) {
    return { value: input.cache.value, cache: input.cache };
  }
  const [applicationBytes, localDataBytes, filesystem, docker] = await Promise.all([
    input.directorySize(input.packageRoot),
    input.directorySize(input.dataDir),
    input.filesystemStats(input.dataDir),
    dockerDisk(input.runtime, input.run)
  ]);
  const components = [
    diskComponent('application', 'Application files', applicationBytes),
    diskComponent('localData', 'Local runtime data', localDataBytes),
    ...docker.components
  ].filter(Boolean);
  const value = {
    usedBytes: sumBytes(components),
    hostTotalBytes: filesystem.totalBytes,
    hostFreeBytes: filesystem.freeBytes,
    complete: docker.complete && Number.isFinite(filesystem.totalBytes) &&
      Number.isFinite(filesystem.freeBytes),
    measuredAt: input.now().toISOString(),
    temporaryBytes: docker.temporaryBytes,
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
