import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync
} from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';

import { FULI_VERSION } from '../package-metadata.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import {
  DEFAULT_RUNTIME_SETTINGS,
  managedProviderUrls,
  readRuntimeSettings
} from '../system/runtime-settings.js';

export const NATIVE_NEO4J_VERSION = '5.26.28';
export const NATIVE_NEO4J_SHA256 =
  '9d4064cdd87627cae376a741c893848c4faa3c4fb980362b6dae541c203e8072';
export const NATIVE_NEO4J_URL =
  `https://dist.neo4j.org/neo4j-community-${NATIVE_NEO4J_VERSION}-unix.tar.gz`;

const MANIFEST_VERSION = 1;
const PROVIDER_RUNTIME_REVISION = 2;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export function createNativeGraphServices({
  paths,
  runtimeDescriptor = null,
  personalOnly = null,
  readText = (path) => readFile(path, 'utf8'),
  writeText = secureWriteText,
  pathExists = existsSync,
  markInitialized = secureMarker,
  readJson = (path) => readJsonFile(path, null),
  readSettings = readRuntimeSettings,
  run = runCommand,
  waitForDatabase = waitForTcp,
  spawnDatabase = spawnNativeDatabase,
  spawnProvider = spawnNativeProvider,
  readProcessState = (path) => readJsonFile(path, null),
  writeProcessState = writeJsonFileAtomic,
  processMatches = processMatchesCommand,
  stopProcess = stopOwnedProcess,
  fetchImpl = globalThis.fetch,
  wait = delay,
  now = () => new Date()
}) {
  const descriptor = runtimeDescriptor ?? readJson(paths.nativeRuntimeManifestPath);

  async function start({ providers: startProviders = true } = {}) {
    assertDescriptor(descriptor);
    const specs = await serviceSpecs();
    const previousState = readProcessState(paths.nativeProcessStatePath) ?? {};
    const databases = {};
    const providers = {};
    try {
      for (const spec of specs) {
        await prepareInstance(spec);
        const existing = previousState.databases?.[spec.id];
        if (
          Number.isInteger(existing?.pid) &&
          typeof existing.command === 'string' &&
          await processMatches(existing.pid, existing.command)
        ) {
          databases[spec.id] = existing;
        } else {
          const child = spawnDatabase(databaseSpec(spec));
          if (!Number.isInteger(child?.pid)) {
            throw new Error(`The native ${spec.id} Neo4j process did not return a process ID.`);
          }
          databases[spec.id] = {
            pid: child.pid,
            command: descriptor.neo4jHome,
            startedAt: now().toISOString()
          };
        }
        persistProcessState(databases, providers);
        await waitForDatabase('127.0.0.1', spec.boltPort);
      }
      if (!startProviders) {
        persistProcessState(databases, providers);
        return;
      }
      for (const spec of specs) {
        const existing = previousState.providers?.[spec.id];
        if (
          Number.isInteger(existing?.pid) &&
          typeof existing.command === 'string' &&
          await processMatches(existing.pid, existing.command)
        ) {
          providers[spec.id] = existing;
        } else {
          const child = spawnProvider(providerSpec(spec));
          if (!Number.isInteger(child?.pid)) {
            throw new Error(`The native ${spec.id} Provider did not return a process ID.`);
          }
          providers[spec.id] = {
            pid: child.pid,
            command: descriptor.providerPython,
            startedAt: now().toISOString()
          };
        }
      }
      persistProcessState(databases, providers);
      for (const spec of specs) await waitForProvider(spec.providerUrl, fetchImpl, wait);
    } catch (error) {
      await stopProviderEntries(providers);
      await stopProviderEntries(databases);
      persistProcessState({}, {});
      throw error;
    }
  }

  async function stopProviders() {
    const state = readProcessState(paths.nativeProcessStatePath) ?? {};
    await stopProviderEntries(state.providers ?? {});
    writeProcessState(paths.nativeProcessStatePath, {
      ...state,
      version: 1,
      mode: 'native',
      databases: state.databases ?? {},
      providers: {},
      updatedAt: now().toISOString()
    });
  }

  async function stopDatabases() {
    await stopProviders();
    if (!descriptor) return;
    const state = readProcessState(paths.nativeProcessStatePath) ?? {};
    if (Object.keys(state.databases ?? {}).length > 0) {
      await stopProviderEntries(state.databases);
    } else {
      // Compatibility with native runtimes created before database PIDs were recorded.
      for (const spec of await serviceSpecs()) {
        await run(join(descriptor.neo4jHome, 'bin', 'neo4j'), ['stop'], {
          env: neo4jEnvironment(spec)
        }).catch(() => {});
      }
    }
    persistProcessState({}, {});
  }

  async function ready() {
    try {
      const specs = await serviceSpecs();
      const checks = await Promise.all(specs.map((spec) => providerReady(
        spec.providerUrl,
        fetchImpl
      )));
      return checks.every(Boolean);
    } catch {
      return false;
    }
  }

  async function serviceSpecs() {
    const settings = paths.runtimeSettingsPath
      ? readSettings(paths.runtimeSettingsPath)
      : DEFAULT_RUNTIME_SETTINGS;
    const values = parseEnv(await readText(paths.graphEnvPath));
    const includeWorkspace = personalOnly === null
      ? managedWorkspaceEnabled(paths, readJson)
      : !personalOnly;
    return nativeInstanceSpecs(paths, settings, values, includeWorkspace);
  }

  async function prepareInstance(spec) {
    const confPath = join(spec.instanceDir, 'conf', 'neo4j.conf');
    await writeText(confPath, nativeNeo4jConfiguration({
      instanceDir: spec.instanceDir,
      httpPort: spec.httpPort,
      boltPort: spec.boltPort,
      memory: spec.memory
    }));
    const marker = join(spec.instanceDir, '.password-initialized');
    if (pathExists(marker)) return;
    await run(join(descriptor.neo4jHome, 'bin', 'neo4j-admin'), [
      'dbms', 'set-initial-password', spec.password
    ], { env: neo4jEnvironment(spec) });
    await markInitialized(marker);
  }

  function neo4jEnvironment(spec) {
    return {
      ...process.env,
      JAVA_HOME: descriptor.javaHome,
      NEO4J_HOME: descriptor.neo4jHome,
      NEO4J_CONF: join(spec.instanceDir, 'conf')
    };
  }

  function providerSpec(spec) {
    return {
      id: spec.id,
      python: descriptor.providerPython,
      port: spec.providerPort,
      logPath: join(spec.instanceDir, 'logs', 'provider.log'),
      environment: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUNBUFFERED: '1',
        GRAPHITI_TELEMETRY_ENABLED: 'false',
        EMBEDDING_DIM: '384',
        FULI_PROVIDER_MODE: spec.providerMode,
        FULI_PROVIDER_ID: spec.providerId,
        FULI_PROVIDER_NAME: spec.providerName,
        FULI_BOOTSTRAP_TOKEN: spec.bootstrapToken,
        ...(spec.humanReviewToken
          ? { FULI_HUMAN_REVIEW_TOKEN: spec.humanReviewToken }
          : {}),
        ...(spec.workflowObservationToken
          ? { FULI_WORKFLOW_OBSERVATION_TOKEN: spec.workflowObservationToken }
          : {}),
        FULI_NEO4J_URI: `bolt://127.0.0.1:${spec.boltPort}`,
        FULI_NEO4J_USER: 'neo4j',
        FULI_NEO4J_PASSWORD: spec.password,
        FULI_EMBEDDING_DIM: '384'
      }
    };
  }

  function databaseSpec(spec) {
    return {
      id: spec.id,
      command: join(descriptor.neo4jHome, 'bin', 'neo4j'),
      args: ['console'],
      pidPath: join(spec.instanceDir, 'run', 'neo4j.pid'),
      logPath: join(spec.instanceDir, 'logs', 'neo4j-console.log'),
      environment: neo4jEnvironment(spec)
    };
  }

  async function stopProviderEntries(entries) {
    for (const entry of Object.values(entries)) {
      if (!Number.isInteger(entry?.pid) || typeof entry.command !== 'string') continue;
      if (await processMatches(entry.pid, entry.command)) await stopProcess(entry.pid);
    }
  }

  function persistProcessState(databases, providers) {
    writeProcessState(paths.nativeProcessStatePath, {
      version: 1,
      mode: 'native',
      databases,
      providers,
      updatedAt: now().toISOString()
    });
  }

  return { start, stopProviders, stopDatabases, ready };
}

export async function ensureNativeRuntime(input, dependencies = {}) {
  const deps = nativeDependencies(dependencies);
  if (!['darwin', 'linux'].includes(deps.platform)) {
    throw new Error('Native graph mode currently supports macOS and Linux. Use container mode here.');
  }
  const javaHome = await deps.resolveJavaHome(input.env ?? process.env);
  if (!javaHome) throw nativeJavaError(deps.platform);
  const uvCommand = await deps.resolveUvCommand(input.env ?? process.env);
  if (!uvCommand) {
    throw new Error('Native graph mode requires uv with Python 3.12 support. Install uv, then run setup again.');
  }

  const providerPython = join(input.paths.nativeProviderVenvPath, 'bin', 'python');
  const expected = {
    version: MANIFEST_VERSION,
    status: 'ready',
    mode: 'native',
    neo4jVersion: NATIVE_NEO4J_VERSION,
    providerVersion: `${FULI_VERSION}+native.${PROVIDER_RUNTIME_REVISION}`,
    javaHome,
    uvCommand,
    neo4jHome: input.paths.nativeNeo4jHome,
    providerPython
  };
  const saved = deps.readManifest(input.paths.nativeRuntimeManifestPath);
  if (manifestReady(saved, expected, input.paths, deps.pathExists)) return saved;

  deps.onProgress(input, `Installing native Neo4j ${NATIVE_NEO4J_VERSION}…`);
  if (!neo4jReady(input.paths, deps.pathExists)) {
    await deps.installNeo4j({
      paths: input.paths,
      home: input.paths.nativeNeo4jHome,
      url: NATIVE_NEO4J_URL,
      sha256: NATIVE_NEO4J_SHA256
    });
  }
  if (!deps.pathExists(providerPython) || saved?.providerVersion !== expected.providerVersion) {
    deps.onProgress(input, 'Installing the native Graph Provider…');
    await deps.installProvider({
      uvCommand,
      venvPath: input.paths.nativeProviderVenvPath,
      providerPython,
      providerSource: join(dirname(dirname(input.paths.graphComposePath)), 'graph-provider'),
      packageRoot: dirname(input.paths.graphComposePath)
    });
  }
  if (!neo4jReady(input.paths, deps.pathExists) || !deps.pathExists(providerPython)) {
    throw new Error('Native graph runtime installation did not produce the required executables.');
  }
  const manifest = { ...expected, installedAt: new Date().toISOString() };
  deps.writeManifest(input.paths.nativeRuntimeManifestPath, manifest);
  return manifest;
}

export function nativeNeo4jConfiguration({
  instanceDir,
  httpPort,
  boltPort,
  memory
}) {
  return [
    'server.default_listen_address=127.0.0.1',
    'server.default_advertised_address=127.0.0.1',
    `server.http.listen_address=127.0.0.1:${httpPort}`,
    `server.http.advertised_address=127.0.0.1:${httpPort}`,
    `server.bolt.listen_address=127.0.0.1:${boltPort}`,
    `server.bolt.advertised_address=127.0.0.1:${boltPort}`,
    `server.directories.data=${join(instanceDir, 'data')}`,
    `server.directories.logs=${join(instanceDir, 'logs')}`,
    `server.directories.run=${join(instanceDir, 'run')}`,
    `server.directories.transaction.logs.root=${join(instanceDir, 'transactions')}`,
    `server.memory.heap.initial_size=${memory.heapInitial}`,
    `server.memory.heap.max_size=${memory.heapMax}`,
    `server.memory.pagecache.size=${memory.pageCache}`,
    'dbms.security.auth_enabled=true',
    'dbms.usage_report.enabled=false',
    ''
  ].join('\n');
}

function manifestReady(saved, expected, paths, pathExists) {
  return saved?.version === expected.version &&
    saved.mode === expected.mode &&
    saved.neo4jVersion === expected.neo4jVersion &&
    saved.providerVersion === expected.providerVersion &&
    saved.javaHome === expected.javaHome &&
    saved.uvCommand === expected.uvCommand &&
    saved.neo4jHome === expected.neo4jHome &&
    saved.providerPython === expected.providerPython &&
    neo4jReady(paths, pathExists) &&
    pathExists(expected.providerPython);
}

function neo4jReady(paths, pathExists) {
  return pathExists(join(paths.nativeNeo4jHome, 'bin', 'neo4j')) &&
    pathExists(join(paths.nativeNeo4jHome, 'bin', 'neo4j-admin'));
}

function nativeJavaError(platform) {
  return new Error(platform === 'darwin'
    ? 'Native graph mode requires Java 21. Install it with `brew install openjdk@21`, then run setup again.'
    : 'Native graph mode requires Java 21. Install an OpenJDK 21 package, then run setup again.');
}

function nativeDependencies(overrides) {
  return {
    platform: process.platform,
    pathExists: existsSync,
    readManifest: (path) => readJsonFile(path, null),
    writeManifest: writeJsonFileAtomic,
    resolveJavaHome,
    resolveUvCommand,
    installNeo4j,
    installProvider,
    onProgress: (input, message) => input.onProgress?.(message),
    ...overrides
  };
}

async function resolveJavaHome(env) {
  const configured = nonEmpty(env.FULI_NATIVE_JAVA_HOME) ?? nonEmpty(env.JAVA_HOME);
  if (configured && existsSync(join(configured, 'bin', 'java'))) return configured;
  if (process.platform === 'darwin') {
    const apple = await commandResult('/usr/libexec/java_home', ['-v', '21'], { env });
    const appleHome = nonEmpty(apple.stdout);
    if (apple.status === 0 && appleHome && existsSync(join(appleHome, 'bin', 'java'))) {
      return appleHome;
    }
    const brew = await commandResult('brew', ['--prefix', 'openjdk@21'], { env });
    const brewHome = nonEmpty(brew.stdout);
    if (brew.status === 0 && brewHome && existsSync(join(brewHome, 'bin', 'java'))) {
      return brewHome;
    }
  }
  const java = await commandResult('java', ['-version'], { env });
  if (java.status === 0 && /(?:version\s+")?21(?:[.\s"]|$)/i.test(java.stderr + java.stdout)) {
    return dirname(dirname(java.command ?? 'java'));
  }
  return null;
}

async function resolveUvCommand(env) {
  const result = await commandResult('uv', ['--version'], { env });
  return result.status === 0 ? 'uv' : null;
}

async function installNeo4j({ paths, home, url, sha256 }) {
  const downloadDir = join(paths.nativeRuntimeDir, 'downloads');
  const archive = join(downloadDir, `neo4j-community-${NATIVE_NEO4J_VERSION}-unix.tar.gz`);
  await mkdir(downloadDir, { recursive: true });
  if (!existsSync(archive) || await sha256File(archive) !== sha256) {
    await downloadFile(url, archive);
  }
  if (await sha256File(archive) !== sha256) {
    throw new Error('The downloaded Neo4j archive failed checksum verification.');
  }
  await rm(home, { recursive: true, force: true });
  await runCommand('tar', ['-xzf', archive, '-C', paths.nativeRuntimeDir]);
}

async function installProvider({ uvCommand, venvPath, providerPython, packageRoot }) {
  await mkdir(dirname(venvPath), { recursive: true });
  if (!existsSync(providerPython)) {
    await runCommand(uvCommand, ['venv', '--python', '3.12', '--seed', venvPath]);
  }
  await runCommand(uvCommand, [
    'pip', 'install', '--python', providerPython, '--upgrade',
    join(packageRoot, 'graph-provider')
  ]);
}

async function downloadFile(url, destination) {
  const partial = `${destination}.partial`;
  let existingBytes = 0;
  try {
    existingBytes = (await stat(partial)).size;
  } catch {
    // No partial download is available to resume.
  }
  const response = await fetch(url, {
    headers: existingBytes > 0 ? { range: `bytes=${existingBytes}-` } : {},
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });
  if (!response.ok || !response.body) {
    throw new Error(`Neo4j download failed with HTTP ${response.status}.`);
  }
  const resumed = existingBytes > 0 && response.status === 206;
  if (!resumed && existingBytes > 0) {
    await rm(partial, { force: true });
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, {
    mode: 0o600,
    flags: resumed ? 'a' : 'w'
  }));
  await rename(partial, destination);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      env: options.env ?? process.env,
      timeout: COMMAND_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(nonEmpty(stderr) ?? nonEmpty(stdout) ?? error.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function commandResult(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      env: options.env ?? process.env,
      timeout: 10_000,
      encoding: 'utf8',
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({ status: error ? 1 : 0, stdout, stderr, command });
    });
  });
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nativeInstanceSpecs(paths, settings, values, includeWorkspace) {
  const memory = {
    heapInitial: values.FULI_NEO4J_HEAP_INITIAL_SIZE ?? '128m',
    heapMax: values.FULI_NEO4J_HEAP_MAX_SIZE ?? '256m',
    pageCache: values.FULI_NEO4J_PAGECACHE_SIZE ?? '64m'
  };
  const urls = managedProviderUrls(settings);
  const personal = {
    id: 'personal',
    instanceDir: paths.nativePersonalDir,
    httpPort: settings.ports.personalNeo4jHttp,
    boltPort: settings.ports.personalNeo4jBolt,
    providerPort: settings.ports.personalProvider,
    providerUrl: urls.personal,
    providerMode: 'personal',
    providerId: 'local-personal',
    providerName: 'Fuli Personal Provider',
    password: requiredEnv(values, 'FULI_PERSONAL_NEO4J_PASSWORD'),
    bootstrapToken: requiredEnv(values, 'FULI_PERSONAL_BOOTSTRAP_TOKEN'),
    humanReviewToken: values.FULI_PERSONAL_HUMAN_REVIEW_TOKEN,
    workflowObservationToken: values.FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN,
    memory
  };
  if (!includeWorkspace) return [personal];
  return [personal, {
    id: 'workspace',
    instanceDir: paths.nativeWorkspaceDir,
    httpPort: settings.ports.workspaceNeo4jHttp,
    boltPort: settings.ports.workspaceNeo4jBolt,
    providerPort: settings.ports.workspaceProvider,
    providerUrl: urls.workspace,
    providerMode: 'workspace',
    providerId: 'development-workspace',
    providerName: 'Fuli Workspace Provider',
    password: requiredEnv(values, 'FULI_WORKSPACE_NEO4J_PASSWORD'),
    bootstrapToken: requiredEnv(values, 'FULI_WORKSPACE_BOOTSTRAP_TOKEN'),
    humanReviewToken: null,
    workflowObservationToken: null,
    memory
  }];
}

function managedWorkspaceEnabled(paths, readJson) {
  const state = readJson(paths.graphRuntimeStatePath) ?? {};
  if (state.managedProviders?.includes('development-workspace')) return true;
  const config = readJson(paths.graphRuntimeConfigPath) ?? {};
  return (config.workspaces ?? []).some((workspace) =>
    workspace?.managedDevelopment === true);
}

function parseEnv(body) {
  const values = {};
  for (const line of String(body).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

function requiredEnv(values, name) {
  const value = nonEmpty(values[name]);
  if (!value) throw new Error(`Native graph runtime is missing ${name}. Run setup again.`);
  return value;
}

function assertDescriptor(descriptor) {
  if (
    descriptor?.status !== 'ready' ||
    descriptor.mode !== 'native' ||
    !nonEmpty(descriptor.javaHome) ||
    !nonEmpty(descriptor.neo4jHome) ||
    !nonEmpty(descriptor.providerPython)
  ) {
    throw new Error('The native graph runtime is not installed. Run setup in native mode first.');
  }
}

async function secureWriteText(path, body) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function secureMarker(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '', { mode: 0o600 });
}

function spawnNativeDatabase(spec) {
  if (existsSync(spec.pidPath)) {
    const pid = Number(readFileSync(spec.pidPath, 'utf8').trim());
    if (Number.isInteger(pid) && processAlive(pid)) return { pid };
    unlinkSync(spec.pidPath);
  }
  mkdirSync(dirname(spec.logPath), { recursive: true });
  const log = openSync(spec.logPath, 'a');
  try {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: spec.environment
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

function spawnNativeProvider(spec) {
  mkdirSync(dirname(spec.logPath), { recursive: true });
  const log = openSync(spec.logPath, 'a');
  try {
    const child = spawn(spec.python, [
      '-m', 'uvicorn', 'fuli_graph.app:app',
      '--host', '127.0.0.1',
      '--port', String(spec.port)
    ], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: spec.environment
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

async function waitForProvider(url, fetchImpl, wait) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await providerReady(url, fetchImpl)) return;
    if (attempt < 119) await wait(1000);
  }
  throw new Error('The native graph Provider did not become ready after starting.');
}

async function providerReady(url, fetchImpl) {
  try {
    const response = await fetchImpl(`${String(url).replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(2500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForTcp(host, port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await tcpReady(host, port)) return;
    if (attempt < 119) await delay(1000);
  }
  throw new Error(`Native Neo4j did not open its local Bolt port ${port}.`);
}

function tcpReady(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ready) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function processMatchesCommand(pid, command) {
  const result = await commandResult('ps', ['-p', String(pid), '-o', 'command=']);
  return result.status === 0 && result.stdout.includes(command);
}

async function stopOwnedProcess(pid) {
  const target = process.platform === 'win32' ? pid : -pid;
  try {
    process.kill(target, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw error;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processAlive(pid)) return;
    await delay(100);
  }
  if (processAlive(pid)) process.kill(target, 'SIGKILL');
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
