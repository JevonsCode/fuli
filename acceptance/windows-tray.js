import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadTrayContext } from '../src/desktop/windows-controller.js';
import { inspectWindowsNativeProcess } from '../src/native-runtime/windows-processes.js';
import { DEFAULT_RUNTIME_SETTINGS, PORT_KEYS } from '../src/system/runtime-settings.js';

assert.equal(process.platform, 'win32');
assert.equal(process.argv.length, 4, 'Expected --bundle PATH');
assert.equal(process.argv[2], '--bundle');
const bundle = resolve(process.argv[3]);
const context = loadTrayContext({ packageRoot: bundle });
assert.equal(existsSync(context.dataDir), false, 'Use the fresh external candidate data directory, never existing user data');
const daily = await dailySnapshot();
const sandbox = await mkdtemp(join(tmpdir(), 'fuli-tray-acceptance-'));
const home = join(sandbox, 'user');
await mkdir(home);
const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
  ComSpec: join(process.env.SystemRoot, 'System32', 'cmd.exe'),
  PATH: join(process.env.SystemRoot, 'System32') + ';' + dirname(powershell),
  PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: sandbox, TMP: sandbox, USERPROFILE: home,
  LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
  FULI_DATA_DIR: join(sandbox, 'decoy data') };
const ports = Object.fromEntries(await Promise.all(PORT_KEYS.map(async key => [key, await freePort()])));
assert.equal(new Set(Object.values(ports)).size, PORT_KEYS.length);
const evidence = { startedAtBeijing: beijingNow(), bundle, dataDir: context.dataDir,
  ports, syntheticOnly: true, nativeTrayLaunched: false, browserOpened: false, uiClickTested: false, checks: [] };
let running = false;
try {
  const files = JSON.parse(await readFile(join(bundle, 'tray-files.sha256.json'), 'utf8'));
  await verifyFiles(files);
  // The launcher and the desktop client it starts.
  for (const name of ['Fuli.exe', 'client/FULI.exe']) {
    const exe = await readFile(join(bundle, name));
    assert.equal(exe.toString('ascii', 0, 2), 'MZ');
    const pe = exe.readUInt32LE(0x3c);
    assert.equal(exe.readUInt16LE(pe + 4), 0x8664, name + ' is Windows x64');
    assert.equal(exe.readUInt16LE(pe + 24 + 68), 2, name + ' uses the GUI subsystem, without a console window');
  }
  const initial = await action('status');
  assert.equal(initial.ok, true);
  assert.equal(initial.status, 'not_configured');
  assert.equal(existsSync(context.dataDir), false);
  check('complete candidate hashes and x64 GUI launcher and desktop client verified; status leaves a fresh external data directory absent');

  await mkdir(context.dataDir);
  await writeFile(join(context.dataDir, 'runtime-settings.json'), JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS,
    graphRuntimeMode: 'native', ports }));
  await writeFile(join(context.dataDir, 'adaptive-runtime-settings.json'), JSON.stringify({ version: 1, enabled: false }));
  await writeFile(join(context.dataDir, 'graph-provider.env'), 'FULI_NEO4J_MEMORY_PROFILE=low\n');
  running = true;
  const started = await action('start');
  assert.equal(started.ok, true, started.error);
  assert.equal(started.status, 'running');
  const original = await processState();
  for (const entry of Object.values(original.databases).concat(Object.values(original.providers))) {
    assert.ok(entry.ownership.executable.startsWith(bundle + '\\'));
  }
  assert.equal((await action('start')).ok, true);
  assert.deepEqual(await processState(), original, 'Repeated start preserves owned process identities');
  check('real controller first/repeated start uses only bundled executables, explicit external data and native ownership');

  const config = await json(join(context.dataDir, 'graph-runtime.json'));
  const request = async (path, body) => {
    const response = await fetch(config.personal.providerUrl + path, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.personal.accessToken },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    assert.equal(response.ok, true, 'Synthetic Provider HTTP ' + response.status);
    return response.json();
  };
  const saved = await request('/v1/knowledge/commits', { space_id: config.personal.spaceId, episode: {
    idempotency_key: 'tray-controller-synthetic-persistence', session_id: 'tray-controller-synthetic',
    name: 'Tray controller synthetic persistence', source_kind: 'synthetic_fixture',
    source_description: 'Isolated tray controller acceptance; not user knowledge.', reference_time: new Date().toISOString(),
    entities: [{ key: 'tray-controller-fixture', name: 'TrayControllerRestartFixture', type: 'SyntheticKnowledge',
      summary: 'TrayControllerRestartFixture survives a restart.', confirmation_status: 'pending' }]
  } });
  evidence.entityId = saved.entity_ids[0];
  await stopAndVerify();
  running = true;
  const restarted = await action('start');
  assert.equal(restarted.ok, true, restarted.error);
  const recalled = await request('/v1/search', { space_ids: [config.personal.spaceId], query: 'TrayControllerRestartFixture',
    include_pending: true, include_personal_global: true, limit: 5 });
  assert.ok(JSON.stringify(recalled).includes(evidence.entityId));
  await stopAndVerify();
  check('real controller stop/start recalls the same persisted synthetic graph entity and releases all recorded processes');

  const sockets = new Set();
  const blocker = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise(resolveListen => blocker.listen(ports.console, '127.0.0.1', resolveListen));
  try {
    evidence.inducedPortConflictOccurredAtBeijing = beijingNow();
    running = true;
    const failed = await action('start');
    evidence.inducedPortConflictDetectedAtBeijing = beijingNow();
    assert.equal(failed.ok, false);
    assert.match(failed.error, /Fuli Graphiti console could not start/);
    assert.equal(failed.status, 'degraded');
    assert.equal((await action('stop')).ok, true);
    running = false;
    assert.equal(await portOpen(ports.console), true, 'The unrelated conflict listener is still alive');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolveClose => blocker.close(resolveClose));
  }
  assert.deepEqual(await Promise.all(Object.values(ports).map(portOpen)), PORT_KEYS.map(() => false));
  check('induced console conflict returns a truthful failed/degraded result; safe stop leaves the unrelated listener untouched');
  assert.equal(existsSync(env.FULI_DATA_DIR), false);
  assert.equal(existsSync(join(bundle, 'data')), false);
  await verifyFiles(files);
  assert.deepEqual(await dailySnapshot(), daily, 'Daily installation, client files, process identities and port states must remain unchanged');
  check('program hashes and daily installation/client/process snapshots are unchanged; neither internal nor decoy data was created');
  evidence.status = 'passed';
  evidence.finishedAtBeijing = beijingNow();
  await writeFile(join(context.dataDir, 'tray-controller-acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
} catch (error) {
  process.stderr.write('Beijing discovery ' + beijingNow() + '; Windows tray controller (no UI); ' + error.message + '\n');
  throw error;
} finally {
  if (running) {
    const stopped = await action('stop');
    if (!stopped.ok) throw new Error('Owned runtime cleanup could not be confirmed: ' + stopped.error);
  }
}

function check(message) { evidence.checks.push(message); process.stdout.write('PASS ' + message + '\n'); }
function beijingNow() { return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }); }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function processState() { return json(join(context.dataDir, 'native-runtime', 'processes.json')); }
async function action(name) {
  return new Promise((resolveAction, reject) => execFile(join(bundle, 'runtime', 'node', 'node.exe'),
    [join(bundle, 'src', 'desktop', 'windows-controller.js'), name], {
      cwd: sandbox, env, windowsHide: true, timeout: 360000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error && error.code !== 1) { reject(new Error(stderr || error.message)); return; }
      try { resolveAction(JSON.parse(stdout)); } catch { reject(new Error('Controller did not return JSON: ' + stderr)); }
    }));
}
async function stopAndVerify() {
  const graph = await processState();
  const consoleState = await json(join(context.dataDir, 'graph-runtime-state.json'));
  const result = await action('stop');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.status, 'stopped');
  running = false;
  const entries = Object.values(graph.databases).concat(Object.values(graph.providers))
    .flatMap(entry => [entry, ...(entry.relatedProcesses ?? [])]);
  for (const entry of entries) assert.equal(await inspectWindowsNativeProcess(entry.pid), null);
  assert.equal(await inspectWindowsNativeProcess(consoleState.pid), null);
  assert.deepEqual(await Promise.all(Object.values(ports).map(portOpen)), PORT_KEYS.map(() => false));
}
async function verifyFiles(files) {
  for (const [name, hash] of files) assert.equal(createHash('sha256').update(await readFile(join(bundle, name))).digest('hex'), hash, name);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}
function portOpen(port) {
  return new Promise(resolveProbe => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolveProbe(value); };
    socket.setTimeout(200, () => done(false));
    socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  });
}
async function dailySnapshot() {
  const data = process.env.FULI_DATA_DIR || join(process.env.LOCALAPPDATA, 'Fuli');
  const paths = ['graph-runtime.json', 'graph-runtime-state.json', 'runtime-settings.json',
    'adaptive-runtime-settings.json', 'graph-provider.env', 'native-runtime/processes.json'].map(name => join(data, name));
  paths.push(join(process.env.USERPROFILE, '.codex', 'config.toml'), join(process.env.USERPROFILE, '.claude', 'settings.json'),
    join(process.env.USERPROFILE, '.cursor', 'mcp.json'), join(dirname(process.execPath), 'node_modules', 'fuli-context', 'package.json'));
  const files = Object.fromEntries(await Promise.all(paths.map(async path => [path,
    existsSync(path) ? createHash('sha256').update(await readFile(path)).digest('hex') : null])));
  const state = existsSync(paths[1]) ? await json(paths[1]) : null;
  const native = existsSync(paths[5]) ? await json(paths[5]) : null;
  const pids = [...new Set([state?.pid, ...Object.values(native?.databases ?? {}).concat(Object.values(native?.providers ?? {}))
    .flatMap(entry => [entry.pid, ...(entry.relatedProcesses ?? []).map(item => item.pid)])].filter(Number.isInteger))];
  const processes = await Promise.all(pids.map(async pid => {
    const observed = await inspectWindowsNativeProcess(pid);
    return observed ? { pid, executable: observed.executable, createdFileTime: observed.createdFileTime,
      commandLineSha256: createHash('sha256').update(observed.commandLine ?? '').digest('hex') } : null;
  }));
  const settings = existsSync(paths[2]) ? await json(paths[2]) : DEFAULT_RUNTIME_SETTINGS;
  return { files, processes, ports: Object.fromEntries(await Promise.all(PORT_KEYS.map(async key => [key,
    { port: settings.ports[key], open: await portOpen(settings.ports[key]) }]))) };
}
