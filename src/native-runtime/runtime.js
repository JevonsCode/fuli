import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CENSUS_QUERIES, censusFromRows } from '../backup/graph-census.js';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync
} from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  writeFile
} from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join, relative } from 'node:path';

import { assertManagedNeo4jHome, withNativeAssetOperation } from './neo4j-asset-state.js';
import { assertMacNativePortFree, assertMacNativePortOwner } from './macos-ports.js';
import { resolveNativeJavaHome } from './java-runtime.js';
import { installNativeNeo4j } from './neo4j-install.js';
import { FULI_VERSION } from '../package-metadata.js';
import { compareSemanticVersions } from '../semantic-version.js';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from './windows-assets.js';
import {
  assertWindowsNativePortFree, assertWindowsNativePortOwner, runWindowsNeo4j, spawnWindowsNativeDatabase,
  spawnWindowsNativeProvider, stopWindowsNativeProcess, windowsNativeProcessMatches,
  waitForWindowsNativeDatabase
} from './windows-processes.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import {
  DEFAULT_RUNTIME_SETTINGS,
  managedProviderUrls,
  readRuntimeSettings
} from '../system/runtime-settings.js';
import { nonEmptyText } from '../validation/values.js';
import { isProcessAlive } from '../local-runtime/processes.js';
import { parseProviderEnv } from '../setup/provider-env.js';

export const NATIVE_NEO4J_VERSION = '5.26.28';
export const NATIVE_NEO4J_SHA256 =
  '9d4064cdd87627cae376a741c893848c4faa3c4fb980362b6dae541c203e8072';
export const NATIVE_NEO4J_URL =
  `https://dist.neo4j.org/neo4j-community-${NATIVE_NEO4J_VERSION}-unix.tar.gz`;

const MANIFEST_VERSION = 1;
const PROVIDER_RUNTIME_REVISION = 2;
const COMMAND_TIMEOUT_MS = 10 * 60_000;

export function createNativeGraphServices({
  paths,
  platform = process.platform,
  env = process.env,
  runtimeDescriptor = null,
  personalOnly = null,
  readText = (path) => readFile(path, 'utf8'),
  writeText = secureWriteText,
  pathExists = existsSync,
  markInitialized = secureMarker,
  readJson = (path) => readJsonFile(path, null),
  readSettings = readRuntimeSettings,
  run = platform === 'win32' ? runWindowsNeo4j : runCommand,
  waitForDatabase = platform === 'win32' ? waitForWindowsNativeDatabase : waitForTcp,
  spawnDatabase = platform === 'win32' ? spawnWindowsNativeDatabase : spawnNativeDatabase,
  spawnProvider = platform === 'win32' ? spawnWindowsNativeProvider : spawnNativeProvider,
  readProcessState = (path) => readJsonFile(path, null),
  writeProcessState = writeJsonFileAtomic,
  processMatches = platform === 'win32' ? windowsNativeProcessMatches : processMatchesCommand,
  stopProcess = platform === 'win32' ? stopWindowsNativeProcess : stopOwnedProcess,
  verifyPortOwner = platform === 'win32' ? assertWindowsNativePortOwner
    : platform === 'darwin' ? assertMacNativePortOwner : async () => {},
  verifyPortFree = platform === 'win32' ? assertWindowsNativePortFree
    : platform === 'darwin' ? assertMacNativePortFree : async () => {},
  fetchImpl = globalThis.fetch,
  wait = delay,
  now = () => new Date()
}) {
  const descriptor = runtimeDescriptor ?? readJson(paths.nativeRuntimeManifestPath);

  const operation = action => platform === 'darwin' ? withNativeAssetOperation(paths, env, action) : action(env);
  const start = options => operation(() => startUnlocked(options));
  const stopProviders = () => operation(() => stopProvidersUnlocked());
  const stopDatabases = () => operation(() => stopDatabasesUnlocked());

  async function startUnlocked({ providers: startProviders = true } = {}) {
    if (platform === 'darwin') {
      const selected = readJson(paths.nativeRuntimeManifestPath);
      if (selected && (selected.status !== 'ready' || selected.neo4jHome !== descriptor?.neo4jHome)) throw new Error('Native Neo4j descriptor is stale or uninstalled. Recreate the service from the selected manifest.');
    }
    assertDescriptor(descriptor);
    const specs = await serviceSpecs();
    const previousState = readProcessState(paths.nativeProcessStatePath) ?? {};
    const databases = {};
    const providers = {};
    const startedDatabases = {};
    const startedProviders = {};
    try {
      for (const spec of specs) {
        await prepareInstance(spec);
        const existing = previousState.databases?.[spec.id];
        if (
          Number.isInteger(existing?.pid) &&
          typeof existing.command === 'string' &&
          await processMatches(existing.pid, existing.command, existing)
        ) {
          databases[spec.id] = existing;
        } else {
          // Nothing is spawned while another process holds either Neo4j port.
          await verifyPortFree(spec.boltPort);
          await verifyPortFree(spec.httpPort);
          const child = await spawnDatabase(databaseSpec(spec));
          if (!Number.isInteger(child?.pid)) {
            throw new Error(`The native ${spec.id} Neo4j process did not return a process ID.`);
          }
          databases[spec.id] = {
            pid: child.pid,
            command: child.command ?? descriptor.neo4jHome,
            ...(child.ownership ? child : {}),
            startedAt: now().toISOString()
          };
          startedDatabases[spec.id] = databases[spec.id];
        }
        persistProcessState(databases, providers);
        await waitForDatabase('127.0.0.1', spec.boltPort, databases[spec.id]);
        await verifyPortOwner(databases[spec.id], spec.boltPort);
        if (platform === 'darwin') {
          await waitForTcp('127.0.0.1', spec.httpPort, databases[spec.id]);
          await verifyPortOwner(databases[spec.id], spec.httpPort);
        }
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
          await processMatches(existing.pid, existing.command, existing)
        ) {
          providers[spec.id] = existing;
        } else {
          await verifyPortFree(spec.providerPort);
          const child = await spawnProvider(providerSpec(spec));
          if (!Number.isInteger(child?.pid)) {
            throw new Error(`The native ${spec.id} Provider did not return a process ID.`);
          }
          providers[spec.id] = {
            pid: child.pid,
            command: child.command ?? descriptor.providerPython,
            ...(child.ownership ? child : {}),
            startedAt: now().toISOString()
          };
          startedProviders[spec.id] = providers[spec.id];
        }
      }
      persistProcessState(databases, providers);
      for (const spec of specs) {
        await waitForProvider(spec.providerUrl, fetchImpl, wait, providers[spec.id]);
        await verifyPortOwner(providers[spec.id], spec.providerPort);
      }
      persistProcessState(databases, providers);
    } catch (error) {
      // A failed compatibility check must not stop services already serving
      // other sessions. Only processes created by this start may be cleaned up.
      await stopProviderEntries(startedProviders);
      await stopProviderEntries(startedDatabases);
      persistProcessState(
        { ...(previousState.databases ?? {}), ...withoutStarted(databases, startedDatabases) },
        { ...(previousState.providers ?? {}), ...withoutStarted(providers, startedProviders) }
      );
      throw error;
    }
  }

  async function stopProvidersUnlocked() {
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

  async function stopDatabasesUnlocked() {
    await stopProvidersUnlocked();
    if (!descriptor) return;
    const state = readProcessState(paths.nativeProcessStatePath) ?? {};
    if (Object.keys(state.databases ?? {}).length > 0) {
      await stopProviderEntries(state.databases);
    } else if (platform !== 'win32') {
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
    const values = parseProviderEnv(await readText(paths.graphEnvPath));
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
      relativeDirectories: platform === 'win32',
      memory: spec.memory
    }));
    const marker = join(spec.instanceDir, '.password-initialized');
    if (pathExists(marker)) return;
    // `--` ends option parsing so a generated password that starts with `-`
    // is still read as the positional <password> value.
    await run(join(descriptor.neo4jHome, 'bin', 'neo4j-admin'), [
      'dbms', 'set-initial-password', '--', spec.password
    ], { env: neo4jEnvironment(spec) });
    await markInitialized(marker);
  }

  function neo4jEnvironment(spec) {
    return {
      ...process.env,
      JAVA_HOME: descriptor.javaHome,
      NEO4J_HOME: platform === 'win32' ? spec.instanceDir : descriptor.neo4jHome,
      NEO4J_CONF: join(spec.instanceDir, 'conf')
    };
  }

  function providerSpec(spec) {
    return {
      id: spec.id,
      python: descriptor.providerPython,
      sourcePath: descriptor.providerSource ?? null,
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
      memory: spec.memory,
      pidPath: join(spec.instanceDir, 'run', 'neo4j.pid'),
      logPath: join(spec.instanceDir, 'logs', 'neo4j-console.log'),
      environment: neo4jEnvironment(spec)
    };
  }

  async function stopProviderEntries(entries) {
    for (const entry of Object.values(entries)) {
      if (!Number.isInteger(entry?.pid) || typeof entry.command !== 'string') continue;
      if (await processMatches(entry.pid, entry.command, entry)) await stopProcess(entry.pid, entry);
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

  // Offline dump/load for backups and migration. The database must be stopped.
  // It runs neo4j-admin exactly as the instance's own start does, so Windows
  // uses the typed AdminTool entry and the instance-relative home and config.
  async function instanceSpec(instanceId) {
    assertDescriptor(descriptor);
    const spec = (await serviceSpecs()).find((item) => item.id === instanceId);
    if (!spec) throw new TypeError(`Unsupported graph instance: ${instanceId}`);
    return spec;
  }

  async function adminDatabase(spec, args) { return operation(() => adminDatabaseUnlocked(spec, args)); }

  async function adminDatabaseUnlocked(spec, args) {
    await prepareInstance(spec);
    return run(join(descriptor.neo4jHome, 'bin', 'neo4j-admin'), args, {
      env: neo4jEnvironment(spec)
    });
  }

  // A stop on Windows terminates Neo4j, so a database with recent writes keeps
  // an active transaction log and neo4j-admin refuses to dump it until it is
  // recovered. Neo4j recovers and checkpoints when it starts; with no Provider
  // running nothing writes after that, so one start-stop cycle makes the store
  // dumpable. A second failure is reported as it is.
  async function dumpDatabase(instanceId, toPath) {
    const spec = await instanceSpec(instanceId);
    const args = ['database', 'dump', 'neo4j', `--to-path=${toPath}`];
    try {
      return await adminDatabase(spec, args);
    } catch {
      await start({ providers: false });
      await stopDatabases();
      return adminDatabase(spec, args);
    }
  }
  const loadDatabase = async (instanceId, fromPath) => adminDatabase(await instanceSpec(instanceId), [
    'database', 'load', 'neo4j', `--from-path=${fromPath}`, '--overwrite-destination=true'
  ]);

  // Reads the content-free census of a running instance over its loopback
  // HTTP endpoint; the caller decides whether the database runs.
  async function censusDatabase(instanceId) {
    const spec = await instanceSpec(instanceId);
    const response = await fetchImpl(`http://127.0.0.1:${spec.httpPort}/db/neo4j/tx/commit`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`neo4j:${spec.password}`).toString('base64')}`
      },
      body: JSON.stringify({
        statements: Object.values(CENSUS_QUERIES).map((statement) => ({ statement }))
      })
    });
    if (!response.ok) throw new Error(`The native ${instanceId} graph census failed (HTTP ${response.status}).`);
    const body = await response.json();
    if (body.errors?.length) throw new Error(`The native ${instanceId} graph census failed: ${body.errors[0].message}`);
    return censusFromRows(Object.fromEntries(Object.keys(CENSUS_QUERIES).map((key, index) =>
      [key, (body.results?.[index]?.data ?? []).map(({ row }) => row)])));
  }

  async function checkDatabaseHealth(instanceId) {
    const spec = await instanceSpec(instanceId);
    const response = await fetchImpl(`http://127.0.0.1:${spec.httpPort}/db/neo4j/tx/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`neo4j:${spec.password}`).toString('base64')}` },
      body: JSON.stringify({ statements: [{ statement: 'CALL dbms.components() YIELD versions RETURN versions[0]' }] }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error('Native Neo4j authenticated health check failed.');
    const body = await response.json(), rows = body.results?.[0]?.data;
    if (body.errors?.length || rows?.length !== 1 || rows[0].row?.[0] !== descriptor.neo4jVersion) throw new Error('Native Neo4j health/version check failed.');
  }

  return { start, stopProviders, stopDatabases, ready, dumpDatabase, loadDatabase, censusDatabase, checkDatabaseHealth };
}

export async function ensureNativeRuntime(input, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) === 'darwin') {
    return (dependencies.withOperation ?? withNativeAssetOperation)(input.paths, input.env ?? process.env,
      env => ensureNativeRuntimeUnlocked({ ...input, env }, dependencies));
  }
  return ensureNativeRuntimeUnlocked(input, dependencies);
}

export async function requireReusableNativeRuntime(input, dependencies = {}) {
  const refuse = () => { throw new Error('Asset-only operation requires separate setup before resuming this console. No Provider or runtime descriptor was changed.'); };
  return ensureNativeRuntime(input, { ...dependencies, installNeo4j: refuse, installProvider: refuse, writeManifest: refuse, onProgress: () => {} });
}

async function ensureNativeRuntimeUnlocked(input, dependencies = {}) {
  const deps = nativeDependencies(dependencies);
  if (deps.platform === 'win32') {
    const saved = deps.readManifest(input.paths.nativeRuntimeManifestPath);
    const assets = deps.resolveWindowsNativeBundle(input.bundle
      ?? deps.readWindowsNativeBundle(dirname(input.paths.graphComposePath)) ?? saved, {
      providerSource: join(dirname(input.paths.graphComposePath), 'graph-provider')
    });
    const providerFingerprint = await deps.providerSourceFingerprint(assets.providerSource);
    if (!/^[a-f0-9]{64}$/.test(providerFingerprint)) throw new Error('Native Graph Provider source fingerprint is invalid.');
    const expected = { version: MANIFEST_VERSION, status: 'ready', mode: 'native',
      providerVersion: FULI_VERSION + '+native.' + PROVIDER_RUNTIME_REVISION, providerFingerprint, ...assets };
    assertProviderUpgrade(saved?.providerVersion, expected.providerVersion, input.allowProviderDowngrade);
    if (Object.entries(expected).every(([key, value]) => saved?.[key] === value)) return saved;
    deps.writeManifest(input.paths.nativeRuntimeManifestPath, expected);
    return expected;
  }
  if (!['darwin', 'linux'].includes(deps.platform)) {
    throw new Error('Native graph mode currently supports macOS and Linux. Use container mode here.');
  }
  const assetLock = join(input.paths.nativeRuntimeDir, '.neo4j-lifecycle.lock');
  const recovery = join(input.paths.nativeRuntimeDir, 'neo4j-transaction.json');
  if (existsSync(assetLock) || existsSync(recovery)) {
    let owner = null;
    try { owner = readFileSync(join(assetLock, 'owner'), 'utf8'); } catch { /* Incomplete ownership is blocked. */ }
    if (!owner || input.env?.FULI_NATIVE_ASSET_OPERATION !== owner) throw new Error('Native Neo4j lifecycle switch or recovery is in progress.');
  }
  const javaHome = await deps.resolveJavaHome(input.env ?? process.env);
  if (!javaHome) throw nativeJavaError(deps.platform);
  const uvCommand = await deps.resolveUvCommand(input.env ?? process.env);
  if (!uvCommand) {
    throw new Error('Native graph mode requires uv with Python 3.12 support. Install uv, then run setup again.');
  }

  const providerPython = join(input.paths.nativeProviderVenvPath, 'bin', 'python');
  const providerSource = join(dirname(input.paths.graphComposePath), 'graph-provider');
  const providerFingerprint = await deps.providerSourceFingerprint(providerSource);
  if (!/^[a-f0-9]{64}$/.test(providerFingerprint)) {
    throw new Error('Native Graph Provider source fingerprint is invalid.');
  }
  const saved = deps.readManifest(input.paths.nativeRuntimeManifestPath);
  let neo4jHome = input.paths.nativeNeo4jHome;
  if (saved?.status === 'ready' && saved.neo4jHome && saved.neo4jVersion === NATIVE_NEO4J_VERSION) {
    neo4jHome = await assertManagedNeo4jHome(input.paths, saved.neo4jHome, NATIVE_NEO4J_VERSION);
  }
  const expected = {
    ...(saved?.previousNeo4jAsset ? { previousNeo4jAsset: saved.previousNeo4jAsset } : {}),
    ...(saved?.neo4jAssetFingerprint ? { neo4jAssetFingerprint: saved.neo4jAssetFingerprint } : {}),
    version: MANIFEST_VERSION,
    status: 'ready',
    mode: 'native',
    neo4jVersion: NATIVE_NEO4J_VERSION,
    providerVersion: `${FULI_VERSION}+native.${PROVIDER_RUNTIME_REVISION}`,
    providerFingerprint,
    javaHome,
    uvCommand,
    neo4jHome,
    providerPython
  };
  if (saved?.neo4jVersion && saved.neo4jVersion !== NATIVE_NEO4J_VERSION) {
    throw new Error('Native Neo4j version changes require an explicit data migration plan. Refusing implicit upgrade or downgrade.');
  }
  assertProviderUpgrade(saved?.providerVersion, expected.providerVersion, input.allowProviderDowngrade);
  if (manifestReady(saved, expected, input.paths, deps.pathExists)) return saved;

  deps.onProgress(input, `Installing native Neo4j ${NATIVE_NEO4J_VERSION}…`);
  if (!neo4jReady(input.paths, deps.pathExists, neo4jHome)) {
    await deps.installNeo4j({
      paths: input.paths,
      home: neo4jHome,
      url: NATIVE_NEO4J_URL,
      sha256: NATIVE_NEO4J_SHA256
    });
  }
  if (
    !deps.pathExists(providerPython) ||
    saved?.providerVersion !== expected.providerVersion ||
    saved?.providerFingerprint !== expected.providerFingerprint
  ) {
    deps.onProgress(input, 'Installing the native Graph Provider…');
    await deps.installProvider({
      uvCommand,
      venvPath: input.paths.nativeProviderVenvPath,
      providerPython,
      providerSource
    });
  }
  if (!neo4jReady(input.paths, deps.pathExists, neo4jHome) || !deps.pathExists(providerPython)) {
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
  relativeDirectories = false,
  memory
}) {
  // A typed Windows instance home plus relative paths avoids Neo4j's PATH
  // setting parser escaping Unicode absolute directory values into other paths.
  return [
    'server.default_listen_address=127.0.0.1',
    'server.default_advertised_address=127.0.0.1',
    `server.http.listen_address=127.0.0.1:${httpPort}`,
    `server.http.advertised_address=127.0.0.1:${httpPort}`,
    `server.bolt.listen_address=127.0.0.1:${boltPort}`,
    `server.bolt.advertised_address=127.0.0.1:${boltPort}`,
    `server.directories.data=${relativeDirectories ? 'data' : join(instanceDir, 'data').replaceAll('\\', '/')}`,
    `server.directories.logs=${relativeDirectories ? 'logs' : join(instanceDir, 'logs').replaceAll('\\', '/')}`,
    `server.directories.run=${relativeDirectories ? 'run' : join(instanceDir, 'run').replaceAll('\\', '/')}`,
    `server.directories.transaction.logs.root=${relativeDirectories ? 'transactions' : join(instanceDir, 'transactions').replaceAll('\\', '/')}`,
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
    saved.providerFingerprint === expected.providerFingerprint &&
    saved.javaHome === expected.javaHome &&
    saved.uvCommand === expected.uvCommand &&
    saved.neo4jHome === expected.neo4jHome &&
    saved.providerPython === expected.providerPython &&
    neo4jReady(paths, pathExists, expected.neo4jHome) &&
    pathExists(expected.providerPython);
}

function neo4jReady(paths, pathExists, home = paths.nativeNeo4jHome) {
  return pathExists(join(home, 'bin', 'neo4j')) &&
    pathExists(join(home, 'bin', 'neo4j-admin'));
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
    resolveJavaHome: resolveNativeJavaHome,
    resolveUvCommand,
    resolveWindowsNativeBundle,
    readWindowsNativeBundle,
    installNeo4j: installNativeNeo4j,
    installProvider,
    providerSourceFingerprint,
    onProgress: (input, message) => input.onProgress?.(message),
    ...overrides
  };
}

async function resolveUvCommand(env) {
  const result = await commandResult('uv', ['--version'], { env });
  return result.status === 0 ? 'uv' : null;
}

async function installProvider({ uvCommand, venvPath, providerPython, providerSource }) {
  await mkdir(dirname(venvPath), { recursive: true });
  if (!existsSync(providerPython)) {
    await runCommand(uvCommand, ['venv', '--python', '3.12', '--seed', venvPath]);
  }
  await runCommand(uvCommand, nativeProviderInstallArguments({
    providerPython,
    providerSource
  }));
}

export function nativeProviderInstallArguments({ providerPython, providerSource }) {
  return [
    'pip', 'install', '--python', providerPython, '--upgrade',
    '--reinstall-package', 'fuli-graph-provider',
    providerSource
  ];
}

async function providerSourceFingerprint(providerSource) {
  const files = [
    join(providerSource, 'pyproject.toml'),
    ...await pythonSourceFiles(join(providerSource, 'fuli_graph'))
  ].sort();
  const hash = createHash('sha256');
  for (const path of files) {
    const name = relative(providerSource, path).replaceAll('\\', '/');
    hash.update(name);
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function pythonSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__pycache__') files.push(...await pythonSourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.py')) {
      files.push(path);
    }
  }
  return files;
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
        reject(new Error(nonEmptyText(stderr) ?? nonEmptyText(stdout) ?? error.message));
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


function requiredEnv(values, name) {
  const value = nonEmptyText(values[name]);
  if (!value) throw new Error(`Native graph runtime is missing ${name}. Run setup again.`);
  return value;
}

function assertDescriptor(descriptor) {
  if (
    descriptor?.status !== 'ready' ||
    descriptor.mode !== 'native' ||
    !nonEmptyText(descriptor.javaHome) ||
    !nonEmptyText(descriptor.neo4jHome) ||
    !nonEmptyText(descriptor.providerPython)
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
    if (Number.isInteger(pid) && isProcessAlive(pid)) {
      throw new Error('A live process is recorded in the Neo4j PID file without verified runtime ownership. Stop its verified owner before starting another copy.');
    }
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

async function waitForProvider(url, fetchImpl, wait, entry) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (entry?.ownership && !isProcessAlive(entry.pid)) throw new Error('The owned native Graph Provider exited during startup');
    const readiness = await providerReadiness(url, fetchImpl);
    if (readiness === 'ready') return;
    if (readiness === 'incompatible') {
      throw new Error('The native Graph Provider is incompatible with transcript capture. Upgrade the Provider and restart local services when existing sessions can release them.');
    }
    if (attempt < 119) await wait(1000);
  }
  throw new Error('The native graph Provider did not become ready after starting.');
}

async function providerReady(url, fetchImpl) {
  return await providerReadiness(url, fetchImpl) === 'ready';
}

async function providerReadiness(url, fetchImpl) {
  try {
    const response = await fetchImpl(`${String(url).replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) return 'unavailable';
    const health = await response.json();
    return health?.transcript_contract === 1 ? 'ready' : 'incompatible';
  } catch {
    return 'unavailable';
  }
}

function withoutStarted(entries, started) {
  return Object.fromEntries(Object.entries(entries).filter(([id]) => !Object.hasOwn(started, id)));
}

// A lower version is refused unless the person asked for it explicitly, for
// example when moving from a local rc build to a public beta of the same release.
function assertProviderUpgrade(installed, requested, allowDowngrade = false) {
  if (allowDowngrade) return;
  let comparison;
  try { comparison = compareSemanticVersions(installed, requested); } catch { return; }
  // SemVer ignores build metadata; Fuli's native revision orders runtime repairs.
  const revision = value => BigInt(/\+native\.(\d+)$/.exec(value)?.[1] ?? '0');
  if (comparison > 0 || (comparison === 0 && revision(installed) > revision(requested))) {
    throw new Error('A newer native Graph Provider is already installed. Refusing an implicit downgrade; use the matching or newer Fuli package, or back up the data folder and run setup with --allow-provider-downgrade.');
  }
}

export async function waitForTcp(host, port, entry) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (entry?.pid && !isProcessAlive(entry.pid)) throw new Error('Native Neo4j process exited before becoming ready.');
    if (await tcpReady(host, port)) {
      if (entry?.pid && !isProcessAlive(entry.pid)) throw new Error('Native Neo4j process exited before becoming ready.');
      return;
    }
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

export async function stopOwnedProcess(pid) {
  const target = process.platform === 'win32' ? pid : -pid;
  const alive = process.platform === 'win32' ? async () => isProcessAlive(pid) : () => processGroupAlive(pid);
  try { process.kill(target, 'SIGTERM'); }
  catch (error) { if (error?.code !== 'ESRCH') throw error; }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!await alive()) return;
    await delay(100);
  }
  if (await alive()) {
    try { process.kill(target, 'SIGKILL'); }
    catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!await alive()) return;
    await delay(100);
  }
  throw new Error('The owned native process group did not stop; recovery requires attention.');
}

async function processGroupAlive(group) {
  const result = await commandResult('ps', ['-eo', 'pgid=,stat=']);
  if (result.status !== 0) throw new Error('Could not verify the native process group stopped.');
  return result.stdout.split('\n').some(line => {
    const [pgid, state] = line.trim().split(/\s+/);
    return Number(pgid) === group && state && !state.startsWith('Z');
  });
}
