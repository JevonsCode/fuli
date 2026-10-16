import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_RUNTIME_SETTINGS, PORT_KEYS } from '../src/system/runtime-settings.js';
import { assertWindowsNativePortOwner, inspectWindowsNativeProcess } from '../src/native-runtime/windows-processes.js';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = { '--bundle': 'bundle', '--moved': 'moved' }[process.argv[index]];
  if (!key || !process.argv[index + 1] || options[key]) throw new Error('Expected --bundle PATH --moved PATH');
  options[key] = resolve(process.argv[index + 1]);
}
assert.equal(process.platform, 'win32');
assert.ok(options.bundle && options.moved && options.bundle !== options.moved);
assert.equal(existsSync(options.moved), false, 'The move destination must be new');
assert.equal(existsSync(join(options.bundle, 'data')), false, 'Use a fresh candidate, never an existing user database');
const originalBundle = options.bundle;
let bundle = originalBundle;
const daily = await dailySnapshot();
const sandbox = await mkdtemp(join(tmpdir(), 'fuli-portable-cli-'));
assert.equal(dirname(resolve(sandbox)), resolve(tmpdir()));
const home = join(sandbox, 'user');
await mkdir(home);
const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// Whitelist the Windows platform environment. No developer runtimes, provider
// keys, npm config, user/global client settings or repository paths are inherited.
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
  ComSpec: join(process.env.SystemRoot, 'System32', 'cmd.exe'),
  PATH: join(process.env.SystemRoot, 'System32') + ';' + dirname(powershell),
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  TEMP: sandbox, TMP: sandbox, USERPROFILE: home,
  FULI_DATA_DIR: join(sandbox, 'decoy data'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming') };
const ports = Object.fromEntries(await Promise.all(PORT_KEYS.map(async key => [key, await freePort()])));
assert.equal(new Set(Object.values(ports)).size, PORT_KEYS.length);
const evidence = { startedAtBeijing: beijingNow(), originalBundle, movedBundle: options.moved,
  excludedTools: [], ports, checks: [], syntheticOnly: true, explorerClickTested: false,
  platformCommands: ['Windows cmd', 'Windows PowerShell/CIM'],
  wslExecutablePresent: existsSync(join(process.env.SystemRoot, 'System32', 'wsl.exe')), wslInvokedByAcceptance: false,
  sandboxRetained: { path: sandbox, reason: 'The OS browser may retain platform temporary files after open; keep the isolated test home for inspection.' } };
let running = false;
try {
  const emptyPort = await freePort();
  await assert.rejects(assertWindowsNativePortOwner({ pid: process.pid }, emptyPort), /\(empty; expected PIDs: \d+; observed PIDs: none\)/);
  const foreign = createServer();
  await new Promise(resolveListen => foreign.listen(0, '127.0.0.1', resolveListen));
  try {
    await assert.rejects(assertWindowsNativePortOwner({ pid: 1 }, foreign.address().port), /\(foreign; expected PIDs: 1; observed PIDs: \d+\)/);
    assert.equal(await portOpen(foreign.address().port), true, 'Foreign listener remains alive after rejection');
  } finally { await new Promise(resolveClose => foreign.close(resolveClose)); }
  check('native port diagnostic distinguishes empty/foreign using numeric PIDs without terminating the foreign listener');
  for (const command of ['docker', 'java', 'node', 'python', 'uv']) {
    await assert.rejects(run(command, ['--version']), error => error.code === 'ENOENT');
    evidence.excludedTools.push(command);
  }
  const inventory = await json(join(bundle, 'portable-inventory.json'));
  const files = await json(join(bundle, 'portable-files.sha256.json'));
  await verifyFiles(files);
  evidence.assetFileCount = files.length;
  evidence.pythonPackages = inventory.pythonPackages.length;
  const python = await run(join(bundle, 'runtime', 'python', 'python.exe'), ['-I', '-B', '-c',
    'import sys,json,fuli_graph,graphiti_core; print(json.dumps({"prefix":sys.prefix,"base_prefix":sys.base_prefix,"isolated":sys.flags.isolated,"user_site":sys.flags.no_user_site,"provider":fuli_graph.__file__}))']);
  const isolated = JSON.parse(python.stdout);
  assert.equal(isolated.prefix, isolated.base_prefix);
  assert.equal(isolated.isolated, 1);
  assert.equal(isolated.user_site, 1);
  assert.ok(isolated.provider.startsWith(bundle));
  check('embedded Python imports the vendored Provider and Graphiti without a host environment');

  await mkdir(join(bundle, 'data'));
  const settings = { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native', ports };
  await writeFile(join(bundle, 'data', 'runtime-settings.json'), JSON.stringify(settings));
  await writeFile(join(bundle, 'data', 'adaptive-runtime-settings.json'), JSON.stringify({ version: 1, enabled: false }));
  await writeFile(join(bundle, 'data', 'graph-provider.env'), 'FULI_NEO4J_MEMORY_PROFILE=low\n');
  for (const name of ['启动并打开 Fuli.cmd', '停止 Fuli.cmd', '仅打开 Fuli.cmd']) {
    const bytes = await readFile(join(bundle, name));
    const text = bytes.toString('utf8');
    assert.deepEqual(Buffer.from(text, 'utf8'), bytes, 'Launcher must be valid UTF8');
    assert.equal(/(?<!\r)\n/.test(text), false, 'Launcher must use CRLF');
  }
  // Preserve both CLI aliases. Lifecycle checks below execute the new batch
  // entries; direct bundled Node calls are reserved for status and cleanup.
  for (const name of ['fuli.cmd', 'fl.cmd']) {
    const launchVersion = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from('& $env:FULI_ACCEPTANCE_LAUNCHER --version; exit $LASTEXITCODE', 'utf16le').toString('base64')],
    { ...env, FULI_ACCEPTANCE_LAUNCHER: join(bundle, name) });
    assert.equal(launchVersion.stdout.trim(), inventory.applicationVersion);
  }
  assert.match((await launcher('stop')).stdout, /"status": "not_configured"/);
  const unopened = await launcher('open', { expectedExit: 1, waitForPause: true });
  assert.match(unopened.stdout + unopened.stderr, /local UI is not running/);
  assert.equal(existsSync(join(bundle, 'data', 'graph-runtime.json')), false);
  assert.deepEqual(await Promise.all(Object.values(ports).map(portOpen)), PORT_KEYS.map(() => false));
  check('UTF8/CRLF entry scripts handle not-configured stop and open-only failure without starting services; failure waits for input');
  running = true; // A failing setup may already own database processes.
  const first = await launcher('start');
  assert.match(first.stdout, /Configuring this directory for the first time/);
  await assertRunning();
  assert.deepEqual(await json(join(bundle, 'data', 'runtime-settings.json')), settings, 'Saved ports/settings must not drift');
  assert.equal((await json(join(bundle, 'data', 'adaptive-runtime-settings.json'))).enabled, false);
  const neo4jConfig = await readFile(join(bundle, 'data', 'native-runtime', 'personal', 'conf', 'neo4j.conf'), 'utf8');
  assert.match(neo4jConfig, /server.memory.heap.max_size=256m/);
  assert.match(neo4jConfig, /server.memory.pagecache.size=64m/);
  assert.equal(existsSync(env.FULI_DATA_DIR), false, 'Explicit package data overrides the decoy FULI_DATA_DIR');
  assert.equal((await fetch('http://127.0.0.1:' + ports.console + '/api/health').then(response => response.json())).version,
    inventory.applicationVersion);
  assert.match(await fetch('http://127.0.0.1:' + ports.console + '/').then(response => response.text()), /id="app"/);
  evidence.consoleUrl = 'http://127.0.0.1:' + ports.console;
  const initial = await processState();
  assert.ok(initial.databases.personal.ownership.executable.startsWith(bundle + '\\'));
  assert.ok(initial.providers.personal.ownership.executable.startsWith(bundle + '\\'));
  const initialConsole = await json(join(bundle, 'data', 'graph-runtime-state.json'));
  assert.match((await launcher('open')).stdout, /Opened: http:\/\/127\.0\.0\.1:/);
  await launcher('start');
  const repeated = await processState();
  assert.deepEqual(repeated.databases, initial.databases, 'Repeated CLI start must preserve the owned Java identity');
  assert.deepEqual(repeated.providers, initial.providers, 'Repeated CLI start must preserve the owned Python identity');
  assert.equal((await json(join(bundle, 'data', 'graph-runtime-state.json'))).pid, initialConsole.pid);
  check('first/repeated start-and-open and open-only use the real bundled CLI; low-memory settings, ownership and explicit data scope are preserved');

  const config = await json(join(bundle, 'data', 'graph-runtime.json'));
  const request = async (path, body) => {
    const response = await fetch(config.personal.providerUrl + path, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.personal.accessToken },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    assert.equal(response.ok, true, 'Synthetic Provider HTTP ' + response.status + ' at ' + path);
    return response.json();
  };
  const saved = await request('/v1/knowledge/commits', { space_id: config.personal.spaceId, episode: {
    idempotency_key: 'portable-cli-synthetic-persistence', session_id: 'portable-cli-synthetic',
    name: 'Portable CLI synthetic persistence', source_kind: 'synthetic_fixture',
    source_description: 'Synthetic portable package acceptance, not user knowledge.', reference_time: '2026-10-16T00:00:00Z',
    entities: [{ key: 'portable-cli-fixture', name: 'PortableCliRestartFixture', type: 'SyntheticKnowledge',
      summary: 'PortableCliRestartFixture survives a directory move.', confirmation_status: 'pending' }]
  } });
  evidence.entityId = saved.entity_ids[0];
  const recall = async () => {
    const result = await request('/v1/search', { space_ids: [config.personal.spaceId], query: 'PortableCliRestartFixture',
      include_pending: true, include_personal_global: true, limit: 5 });
    assert.ok(JSON.stringify(result).includes(evidence.entityId), 'Read the same persisted entity ID');
  };
  await stopAndVerify();
  assert.match((await launcher('stop')).stdout, /"status": "stopped"/);
  running = true; await launcher('start');
  await assertRunning(); await recall();
  check('real CLI stop/start reads the same synthetic graph entity');
  await stopAndVerify();

  const blockedSockets = new Set();
  const blocker = createServer(socket => {
    blockedSockets.add(socket);
    socket.once('close', () => blockedSockets.delete(socket));
    socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise(resolveListen => blocker.listen(ports.console, '127.0.0.1', resolveListen));
  try {
    running = true;
    const failed = await launcher('start', { expectedExit: 1, waitForPause: true });
    evidence.portConflictDetectedAtBeijing = beijingNow();
    assert.match(failed.stdout + failed.stderr, /Fuli Graphiti console could not start/);
    assert.ok(failed.stdout.includes(join(bundle, 'data', 'logs')));
    assert.ok(failed.stdout.includes(join(bundle, 'data', 'native-runtime', 'personal', 'logs')));
    const log = await readFile(join(bundle, 'data', 'logs', 'runtime.log'), 'utf8');
    assert.match(log, /EADDRINUSE/);
    assert.ok(log.includes(String(ports.console)), 'The actual log identifies the conflicting console port');
    assert.ok(existsSync(join(bundle, 'data', 'native-runtime', 'personal', 'logs', 'provider.log')));
    assert.ok(existsSync(join(bundle, 'data', 'native-runtime', 'personal', 'logs', 'neo4j-console.log')));
    const failedProcesses = await processState();
    await launcher('stop'); running = false;
    await assertNativePidsReleased(failedProcesses);
  } finally {
    for (const socket of blockedSockets) socket.destroy();
    await new Promise(resolveClose => blocker.close(resolveClose));
  }
  assert.deepEqual(await Promise.all(Object.values(ports).map(portOpen)), PORT_KEYS.map(() => false));
  check('console-port conflict preserves the original failure and real log locations, waits for input, then owned cleanup releases ports');

  assert.equal(existsSync(join(bundle, 'data', 'graph-runtime-state.json')), false);
  await rename(bundle, options.moved);
  bundle = options.moved;
  assert.equal(existsSync(originalBundle), false, 'Old application directory must no longer exist');
  running = true; await launcher('start');
  await assertRunning(); await recall();
  const rebound = await json(join(bundle, 'data', 'native-runtime', 'manifest.json'));
  for (const key of ['javaHome', 'neo4jHome', 'providerPython', 'providerSource']) {
    assert.ok(rebound[key].startsWith(bundle + '\\'));
    assert.equal(rebound[key].includes(originalBundle), false);
  }
  const movedProcesses = await processState();
  assert.ok(movedProcesses.databases.personal.ownership.executable.startsWith(bundle));
  assert.ok(movedProcesses.providers.personal.ownership.executable.startsWith(bundle));
  await verifyFiles(files);
  check('stopped application/runtime/data move starts at a new Chinese path with the old path absent');
  await stopAndVerify();
  await verifyFiles(files);
  check('all recorded processes and ports are released; built application/runtime SHA256 files are unchanged; data retained');
  assert.equal(existsSync(env.FULI_DATA_DIR), false);
  assert.deepEqual(await dailySnapshot(), daily, 'Daily configuration hashes, recorded PID identities and ports must remain unchanged');
  evidence.dailyBaseline = { trackedPaths: Object.keys(daily.files).length,
    existingFiles: Object.values(daily.files).filter(value => value !== null).length,
    installedVersion: daily.installedVersion,
    pids: daily.processes.map(item => item?.pid).filter(Boolean),
    ports: daily.ports };
  check('daily file hashes, recorded process identities and port states are unchanged; the decoy data directory was never created');
  evidence.finishedAtBeijing = beijingNow();
  evidence.status = 'passed';
  await writeFile(join(bundle, 'data', 'portable-acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
} catch (error) {
  process.stderr.write('Beijing discovery ' + beijingNow() + '; isolated Windows portable CLI acceptance; ' + error.message + '\n');
  throw error;
} finally {
  if (running) await cli(['stop']).catch(error => process.stderr.write('Owned cleanup failed: ' + error.message + '\n'));
  assert.equal(dirname(sandbox), resolve(tmpdir()));
  // The OS browser is not a managed Fuli process. Preserve its test TEMP/home
  // rather than deleting live platform files or terminating the user's browser.
}

function check(message) { evidence.checks.push(message); process.stdout.write('PASS ' + message + '\n'); }
function beijingNow() { return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }); }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function processState() { return json(join(bundle, 'data', 'native-runtime', 'processes.json')); }
async function cli(args, expectedExit = 0) {
  return run(join(bundle, 'runtime', 'node', 'node.exe'), [join(bundle, 'src', 'cli.js'), ...args,
    '--data-dir', join(bundle, 'data')], env, expectedExit);
}
async function launcher(action, { expectedExit = 0, waitForPause = false } = {}) {
  const name = { start: '启动并打开 Fuli.cmd', stop: '停止 Fuli.cmd', open: '仅打开 Fuli.cmd' }[action];
  // PowerShell's native-command wrapper can wait for detached service descendants.
  // Run the same batch entry directly, hidden, with CMD's quoted /s /c contract.
  return run(env.ComSpec, ['/d', '/v:off', '/s', '/c', `""${join(bundle, name)}""`],
    env, expectedExit, { waitForPause, windowsVerbatimArguments: true });
}
async function assertRunning() {
  const status = JSON.parse((await cli(['status', '--json'])).stdout);
  assert.equal(status.status, 'running');
  assert.equal(status.console.status, 'ready');
  assert.equal(status.personal.status, 'ready');
}
async function stopAndVerify() {
  const graph = await processState();
  const consoleState = await json(join(bundle, 'data', 'graph-runtime-state.json'));
  assert.match((await launcher('stop')).stdout, /"status": "stopped"/); running = false;
  await assertNativePidsReleased(graph);
  assert.equal(await inspectWindowsNativeProcess(consoleState.pid), null, 'Owned console PID released');
  evidence.releasedPids ??= [];
  if (!evidence.releasedPids.includes(consoleState.pid)) evidence.releasedPids.push(consoleState.pid);
  assert.deepEqual(await Promise.all(Object.values(ports).map(portOpen)), PORT_KEYS.map(() => false));
  assert.equal(JSON.parse((await cli(['status', '--json'], 1)).stdout).status, 'stopped');
}
async function assertNativePidsReleased(graph) {
  const entries = [graph.databases.personal, graph.providers.personal].filter(Boolean)
    .flatMap(entry => [entry, ...(entry.relatedProcesses ?? [])]);
  evidence.releasedPids ??= [];
  for (const entry of entries) {
    assert.equal(await inspectWindowsNativeProcess(entry.pid), null, 'Owned native PID released');
    if (!evidence.releasedPids.includes(entry.pid)) evidence.releasedPids.push(entry.pid);
  }
}
async function verifyFiles(files) {
  for (const [name, expected] of files) {
    const local = relative(bundle, resolve(bundle, name));
    assert.ok(local && !local.startsWith('..') && !isAbsolute(local));
    const bytes = await readFile(join(bundle, name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'Bundled file SHA256: ' + name);
  }
}
async function freePort() {
  const server = createServer();
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose)); return port;
}
function portOpen(port) {
  return new Promise(resolveOpen => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolveOpen(value); };
    socket.setTimeout(300, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  });
}
async function dailySnapshot() {
  const data = process.env.FULI_DATA_DIR || join(process.env.LOCALAPPDATA, 'Fuli');
  const files = [join(data, 'graph-runtime.json'), join(data, 'graph-runtime-state.json'),
    join(data, 'runtime-settings.json'), join(data, 'adaptive-runtime-settings.json'),
    join(data, 'graph-provider.env'), join(data, 'native-runtime', 'processes.json'),
    join(process.env.USERPROFILE, '.codex', 'config.toml'), join(process.env.USERPROFILE, '.claude', 'settings.json'),
    join(process.env.USERPROFILE, '.cursor', 'mcp.json'),
    join(dirname(process.execPath), 'node_modules', 'fuli-context', 'package.json')];
  const hashes = Object.fromEntries(await Promise.all(files.map(async path => [path,
    existsSync(path) ? createHash('sha256').update(await readFile(path)).digest('hex') : null])));
  const state = existsSync(files[1]) ? await json(files[1]) : null;
  const native = existsSync(files[5]) ? await json(files[5]) : null;
  const pids = [...new Set([state?.pid, ...[...Object.values(native?.databases ?? {}), ...Object.values(native?.providers ?? {})]
    .flatMap(entry => [entry.pid, ...(entry.relatedProcesses ?? []).map(item => item.pid)])].filter(Number.isInteger))];
  const settings = existsSync(files[2]) ? await json(files[2]) : DEFAULT_RUNTIME_SETTINGS;
  const processes = await Promise.all(pids.map(async pid => {
    const observed = await inspectWindowsNativeProcess(pid);
    return observed ? { pid, executable: observed.executable, createdFileTime: observed.createdFileTime,
      commandLineSha256: createHash('sha256').update(observed.commandLine ?? '').digest('hex') } : null;
  }));
  return { files: hashes, processes, installedVersion: existsSync(files[9]) ? (await json(files[9])).version : null,
    ports: Object.fromEntries(await Promise.all(PORT_KEYS.map(async key => [key,
      { port: settings.ports[key], open: await portOpen(settings.ports[key]) }]))) };
}
function run(command, args, childEnv = env, expectedExit = 0, { waitForPause = false, windowsVerbatimArguments = false } = {}) {
  return new Promise((resolveRun, reject) => {
    let pauseSeen = false, heldForInput = false, release;
    const child = execFile(command, args, { cwd: sandbox, env: childEnv,
    windowsHide: true, windowsVerbatimArguments, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    clearTimeout(release);
    if (waitForPause && !heldForInput) { reject(new Error('Failure launcher did not wait for input')); return; }
    if ((!error && expectedExit === 0) || error?.code === expectedExit) resolveRun({ stdout, stderr });
    else if (error?.code === 'ENOENT') reject(error);
    else reject(new Error('Portable CLI exit ' + (error?.code ?? 0) + ': ' + (stderr || stdout).slice(-2500)));
    });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!pauseSeen && output.includes('Press any key to close.')) {
        pauseSeen = true;
        release = setTimeout(() => {
          heldForInput = child.exitCode === null && child.signalCode === null;
          child.stdin.end('\r\n');
        }, 250);
      }
    });
  });
}
