import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_RUNTIME_SETTINGS, PORT_KEYS } from '../src/system/runtime-settings.js';
import { inspectWindowsNativeProcess } from '../src/native-runtime/windows-processes.js';

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
const sandbox = await mkdtemp(join(tmpdir(), 'fuli-portable-cli-'));
assert.equal(dirname(resolve(sandbox)), resolve(tmpdir()));
const home = join(sandbox, 'user');
await mkdir(home);
const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// Whitelist the Windows platform environment. No developer runtimes, provider
// keys, npm config, user/global client settings or repository paths are inherited.
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
  ComSpec: join(process.env.SystemRoot, 'System32', 'cmd.exe'), PATH: dirname(powershell),
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  TEMP: sandbox, TMP: sandbox, USERPROFILE: home,
  LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming') };
const ports = Object.fromEntries(await Promise.all(PORT_KEYS.map(async key => [key, await freePort()])));
assert.equal(new Set(Object.values(ports)).size, PORT_KEYS.length);
const evidence = { startedAtBeijing: beijingNow(), originalBundle, movedBundle: options.moved,
  excludedTools: [], ports, checks: [], syntheticOnly: true };
let running = false;
try {
  for (const command of ['docker', 'wsl', 'java', 'node', 'python', 'uv']) {
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
  await writeFile(join(bundle, 'data', 'runtime-settings.json'), JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS,
    graphRuntimeMode: 'native', ports }));
  // Exercise the shipped .cmd launcher too; all subsequent commands execute
  // its same real CLI entry through the bundled Node for structured output.
  const launchVersion = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from('& $env:FULI_ACCEPTANCE_LAUNCHER --version; exit $LASTEXITCODE', 'utf16le').toString('base64')],
  { ...env, FULI_ACCEPTANCE_LAUNCHER: join(bundle, 'fuli.cmd') });
  assert.equal(launchVersion.stdout.trim(), inventory.applicationVersion);
  running = true; // A failing setup may already own database processes.
  await cli(['setup', '--yes', '--skip-agents', '--personal-only', '--runtime-mode', 'native',
    '--no-adaptive-memory', '--data-dir', join(bundle, 'data')]);
  await assertRunning();
  assert.equal((await fetch('http://127.0.0.1:' + ports.console + '/api/health').then(response => response.json())).version,
    inventory.applicationVersion);
  assert.match(await fetch('http://127.0.0.1:' + ports.console + '/').then(response => response.text()), /id="app"/);
  const initial = await processState();
  await cli(['start']);
  const repeated = await processState();
  assert.deepEqual(repeated.databases, initial.databases, 'Repeated CLI start must preserve the owned Java identity');
  assert.deepEqual(repeated.providers, initial.providers, 'Repeated CLI start must preserve the owned Python identity');
  check('real CLI setup/status/start and the web console use only bundled assets');

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
  running = true; await cli(['start']);
  await assertRunning(); await recall();
  check('real CLI stop/start reads the same synthetic graph entity');
  await stopAndVerify();

  assert.equal(existsSync(join(bundle, 'data', 'graph-runtime-state.json')), false);
  await rename(bundle, options.moved);
  bundle = options.moved;
  assert.equal(existsSync(originalBundle), false, 'Old application directory must no longer exist');
  running = true; await cli(['start']);
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
  await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function check(message) { evidence.checks.push(message); process.stdout.write('PASS ' + message + '\n'); }
function beijingNow() { return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }); }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function processState() { return json(join(bundle, 'data', 'native-runtime', 'processes.json')); }
async function cli(args, expectedExit = 0) {
  return run(join(bundle, 'runtime', 'node', 'node.exe'), [join(bundle, 'src', 'cli.js'), ...args], env, expectedExit);
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
  const entries = [graph.databases.personal, graph.providers.personal].filter(Boolean)
    .flatMap(entry => [entry, ...(entry.relatedProcesses ?? [])]);
  await cli(['stop']); running = false;
  for (const entry of entries) assert.equal(await inspectWindowsNativeProcess(entry.pid), null, 'Owned native PID released');
  assert.equal(await inspectWindowsNativeProcess(consoleState.pid), null, 'Owned console PID released');
  assert.deepEqual(await Promise.all(Object.values(ports).map(portOpen)), PORT_KEYS.map(() => false));
  assert.equal(JSON.parse((await cli(['status', '--json'], 1)).stdout).status, 'stopped');
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
function run(command, args, childEnv = env, expectedExit = 0) {
  return new Promise((resolveRun, reject) => execFile(command, args, { cwd: sandbox, env: childEnv,
    windowsHide: true, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if ((!error && expectedExit === 0) || error?.code === expectedExit) resolveRun({ stdout, stderr });
    else if (error?.code === 'ENOENT') reject(error);
    else reject(new Error('Portable CLI exit ' + (error?.code ?? 0) + ': ' + (stderr || stdout).slice(-2500)));
  }));
}
