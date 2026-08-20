import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createNativeGraphServices } from '../native-runtime/runtime.js';
import { ensureContainerRuntime } from '../setup/container-runtime.js';
import { readJsonFile } from '../storage/json-file.js';
import {
  graphBackupSelection,
  reconcileImportedGraphIdentity
} from './identity-reconciliation.js';

const COMMAND_TIMEOUT_MS = 10 * 60_000;

export async function createGraphBackupAdapter({
  mode,
  paths,
  onProgress = () => {},
  ensureContainer = ensureContainerRuntime,
  run = runCommand
}) {
  const instances = managedGraphInstances(paths);
  if (mode === 'native') return createNativeBackupAdapter({ paths, instances, run });
  if (mode === 'container') {
    const runtime = await ensureContainer({ onProgress });
    return createContainerBackupAdapter({ paths, instances, runtime, run });
  }
  throw new TypeError('Graph backup runtime mode must be container or native.');
}

export function managedGraphInstances(paths) {
  const state = readJsonFile(paths.graphRuntimeStatePath, null);
  const config = readJsonFile(paths.graphRuntimeConfigPath, null);
  const workspace = state?.managedProviders?.includes('development-workspace') ||
    (config?.workspaces ?? []).some(({ managedDevelopment }) => managedDevelopment === true);
  return workspace ? ['personal', 'workspace'] : ['personal'];
}

function createNativeBackupAdapter({ paths, instances, run }) {
  const descriptor = readJsonFile(paths.nativeRuntimeManifestPath, null);
  if (descriptor?.status !== 'ready' || descriptor.mode !== 'native') {
    throw new Error(
      'Native graph mode is not initialized. Run `fuli setup --runtime-mode native` first.'
    );
  }
  const services = createNativeGraphServices({
    paths,
    runtimeDescriptor: descriptor,
    personalOnly: !instances.includes('workspace')
  });

  async function stop() {
    const lifecycle = nativeRuntimeLifecycle(paths, instances);
    await services.stopDatabases();
    return lifecycle;
  }

  async function start(lifecycle = {}) {
    if (lifecycle.resumeProviders === true) {
      await services.start();
    } else if (lifecycle.resumeDatabases === true) {
      await services.start({ providers: false });
    }
  }

  async function dump(instance, destination) {
    const spec = nativeSpec(paths, descriptor, instance);
    await withStagingDirectory(destination, async (stage) => {
      await run(join(descriptor.neo4jHome, 'bin', 'neo4j-admin'), [
        'database', 'dump', 'neo4j', `--to-path=${stage}`
      ], { env: spec.environment });
      await rename(join(stage, 'neo4j.dump'), destination);
    });
  }

  async function load(instance, source) {
    const spec = nativeSpec(paths, descriptor, instance);
    await withStagingDirectory(source, async (stage) => {
      await copyFile(source, join(stage, 'neo4j.dump'));
      await run(join(descriptor.neo4jHome, 'bin', 'neo4j-admin'), [
        'database', 'load', 'neo4j', `--from-path=${stage}`, '--overwrite-destination=true'
      ], { env: spec.environment });
    });
  }

  function hasData(instance) {
    return existsSync(join(nativeInstanceDir(paths, instance), 'data', 'databases', 'neo4j'));
  }

  async function reconcile(input) {
    await services.start();
    try {
      return await reconcileImportedGraphIdentity({ paths, instances, ...input });
    } finally {
      await services.stopDatabases();
    }
  }

  return {
    mode: 'native',
    instances,
    stop,
    start,
    dump,
    load,
    hasData,
    selection: () => graphBackupSelection(paths),
    reconcile
  };
}

function createContainerBackupAdapter({ paths, instances, runtime, run }) {
  const composePrefix = [
    'compose', '--env-file', paths.graphEnvPath, '-f', paths.graphComposePath
  ];
  const services = instances.flatMap((instance) => [
    `${instance}-provider`, `${instance}-neo4j`
  ]);

  async function docker(args) {
    return run(runtime.dockerCommand, args, { env: runtime.dockerEnvironment });
  }

  async function stop() {
    const running = await docker([
      ...composePrefix, 'ps', '--status', 'running', '--services', ...services
    ]);
    const resumeServices = String(running).split(/\r?\n/)
      .map((service) => service.trim())
      .filter((service) => services.includes(service));
    await docker([...composePrefix, 'stop', '-t', '30', ...services]);
    return { resume: resumeServices.length > 0, resumeServices };
  }

  async function start(lifecycle = {}) {
    const resumeServices = Array.isArray(lifecycle.resumeServices)
      ? lifecycle.resumeServices.filter((service) => services.includes(service))
      : (lifecycle.resume === true ? services : []);
    if (resumeServices.length === 0) return;
    await docker([...composePrefix, 'up', '-d', '--no-build', ...resumeServices]);
  }

  async function dump(instance, destination) {
    await withBackupHelper(instance, async (helper) => {
      await docker([
        'exec', helper,
        'neo4j-admin', 'database', 'dump', 'neo4j', '--to-path=/backup'
      ]);
      await docker(['cp', `${helper}:/backup/neo4j.dump`, destination]);
    });
  }

  async function load(instance, source) {
    await withBackupHelper(instance, async (helper) => {
      await docker(['cp', source, `${helper}:/backup/neo4j.dump`]);
      await docker([
        'exec', helper,
        'neo4j-admin', 'database', 'load', 'neo4j',
        '--from-path=/backup', '--overwrite-destination=true'
      ]);
    });
  }

  async function hasData(instance) {
    return withBackupHelper(instance, async (helper) => {
      try {
        await docker(['exec', helper, 'test', '-d', '/data/databases/neo4j']);
        return true;
      } catch {
        return false;
      }
    });
  }

  async function reconcile(input) {
    await docker([...composePrefix, 'up', '-d', '--no-build', ...services]);
    try {
      return await reconcileImportedGraphIdentity({ paths, instances, ...input });
    } finally {
      await docker([...composePrefix, 'stop', '-t', '30', ...services]);
    }
  }

  async function withBackupHelper(instance, operation) {
    const helper = `fuli-neo4j-backup-${randomUUID()}`;
    try {
      await docker([
        ...composePrefix,
        'run', '--detach', '--name', helper, '--no-deps', '-T',
        `${instance}-neo4j`, 'tail', '-f', '/dev/null'
      ]);
      await docker(['exec', helper, 'mkdir', '-p', '/backup']);
      return await operation(helper);
    } finally {
      await docker(['rm', '--force', helper]).catch(() => {});
    }
  }

  return {
    mode: 'container',
    instances,
    stop,
    start,
    dump,
    load,
    hasData,
    selection: () => graphBackupSelection(paths),
    reconcile
  };
}

function nativeSpec(paths, descriptor, instance) {
  const instanceDir = nativeInstanceDir(paths, instance);
  return {
    instanceDir,
    environment: {
      ...process.env,
      JAVA_HOME: descriptor.javaHome,
      NEO4J_HOME: descriptor.neo4jHome,
      NEO4J_CONF: join(instanceDir, 'conf')
    }
  };
}

function nativeInstanceDir(paths, instance) {
  if (instance === 'personal') return paths.nativePersonalDir;
  if (instance === 'workspace') return paths.nativeWorkspaceDir;
  throw new TypeError(`Unsupported graph instance: ${instance}`);
}

function nativeRuntimeLifecycle(paths, instances) {
  const processes = readJsonFile(paths.nativeProcessStatePath, null);
  const resumeProviders = Object.keys(processes?.providers ?? {}).length > 0;
  const resumeDatabases = Object.keys(processes?.databases ?? {}).length > 0 || instances.some((instance) =>
    existsSync(join(nativeInstanceDir(paths, instance), 'run', 'neo4j.pid')));
  return {
    resume: resumeProviders || resumeDatabases,
    resumeProviders,
    resumeDatabases: resumeProviders || resumeDatabases
  };
}

async function withStagingDirectory(referencePath, operation) {
  const parent = dirname(referencePath);
  const stage = join(parent, `.fuli-neo4j-${randomUUID()}`);
  await mkdir(stage, { recursive: false, mode: 0o700 });
  try {
    return await operation(stage);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function runCommand(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      env: env ?? process.env,
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
      else resolve(stdout);
    });
  });
}
