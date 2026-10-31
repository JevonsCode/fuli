import assert from 'node:assert/strict';
import { existsSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { loadTrayContext, validateTrayDataDir } from '../src/desktop/windows-controller.js';
import { runTrayAction, trayStateLabel } from '../src/desktop/desktop-controller.js';
import { refreshEmbeddedProvider } from '../scripts/build-windows-tray.js';

async function fixture(t) {
  // The tray context canonicalizes its paths, so derive expectations from the same real path
  // (macOS tmpdir() is /var/..., which resolves to /private/var/...).
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'fuli-tray-test-')));
  t.after(async () => { assert.equal(dirname(root), realpathSync(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const packageRoot = join(root, 'app');
  const dataDir = join(root, 'external data');
  const env = { LOCALAPPDATA: join(root, 'daily') };
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, 'native-bundle.json'), JSON.stringify({ version: 1, platform: 'win32', arch: 'x64',
    providerPackaging: 'embedded', neo4jHome: 'runtime/neo4j', javaHome: 'runtime/jre21',
    providerPython: 'runtime/python/python.exe', providerSource: 'runtime/python/Lib/site-packages', dataDir: 'data' }));
  await writeFile(join(packageRoot, 'tray-config.json'), JSON.stringify({ version: 1, kind: 'windows-tray-candidate', dataDir }));
  return { root, packageRoot, dataDir, env, context: loadTrayContext({ packageRoot, env }) };
}

const reply = state => ({ code: state.status === 'running' ? 0 : 1, stdout: JSON.stringify(state), stderr: '' });
const stopped = { status: 'stopped', console: { status: 'stopped' } };
const running = { status: 'running', console: { status: 'ready' } };
async function configured(f, mode = 'native') {
  await mkdir(f.dataDir);
  await writeFile(join(f.dataDir, 'graph-runtime.json'), '{}');
  await writeFile(join(f.dataDir, 'runtime-settings.json'), JSON.stringify({ graphRuntimeMode: mode }));
}

test('tray context pins external data without creating it or following FULI_DATA_DIR', async t => {
  const f = await fixture(t);
  const again = loadTrayContext({ packageRoot: f.packageRoot,
    env: { ...f.env, FULI_DATA_DIR: join(f.root, 'decoy') } });
  assert.equal(again.dataDir, f.dataDir);
  assert.equal(again.instanceKey, f.context.instanceKey);
  assert.equal(existsSync(f.dataDir), false);
  assert.throws(() => validateTrayDataDir(f.packageRoot, join(f.packageRoot, 'data'), f.env), /outside/);
  assert.throws(() => validateTrayDataDir(f.packageRoot, join(f.env.LOCALAPPDATA, 'Fuli'), f.env), /daily/);
  assert.throws(() => validateTrayDataDir(f.packageRoot, 'relative data', f.env), /absolute/);
  await writeFile(join(f.packageRoot, 'tray-config.json'), JSON.stringify({ version: 2, dataDir: f.dataDir }));
  assert.throws(() => loadTrayContext({ packageRoot: f.packageRoot, env: f.env }), /not supported/);
});

test('status accepts the existing stopped exit code and does not configure or start', async t => {
  const f = await fixture(t);
  const calls = [];
  const result = await runTrayAction('status', f.context, { runCli: async (context, args) => {
    assert.equal(context.nodePath, join(f.packageRoot, 'runtime', 'node', 'node.exe'));
    calls.push(args);
    return reply({ status: 'not_configured' });
  } });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'not_configured');
  assert.deepEqual(calls, [['status', '--json', '--data-dir', f.dataDir]]);
  assert.equal(existsSync(f.dataDir), false);
});

test('first explicit start/open scopes setup, skips Agent integration, then opens the real CLI console', async t => {
  const f = await fixture(t);
  const calls = [];
  const result = await runTrayAction('start-open', f.context, { runCli: async (context, args) => {
    assert.deepEqual(args.slice(-2), ['--data-dir', f.dataDir]);
    calls.push(args);
    return args[0] === 'status' ? reply(running) : { code: 0, stdout: '', stderr: '' };
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ['setup', '--yes', '--skip-agents', '--personal-only', '--runtime-mode', 'native', '--data-dir', f.dataDir]);
  assert.deepEqual(calls.map(args => args[0]), ['setup', 'status', 'open', 'status']);
});

test('a first setup that reports partial still counts when FULI runs; one that failed does not', async t => {
  const f = await fixture(t);
  const start = (setup, state) => runTrayAction('start', f.context, { portBlocked: async () => false,
    runCli: async (context, args) => args[0] === 'setup' ? setup : reply(state) });
  const partial = { code: 1, stdout: 'Knowledge recovery is pending.', stderr: '' };
  assert.equal((await start(partial, running)).ok, true);
  const stillStopped = await start(partial, stopped);
  assert.equal(stillStopped.ok, false);
  assert.match(stillStopped.error, /running state/);
  const failed = await start({ code: 1, stdout: '', stderr: 'Native Neo4j did not open its local Bolt port.' }, running);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Bolt port/);
});

test('opening an already running selection preserves its processes; open-only never starts', async t => {
  const f = await fixture(t);
  await configured(f);
  const calls = [];
  const runCli = async (context, args) => {
    calls.push(args[0]);
    return args[0] === 'status' ? reply(running) : { code: 0, stdout: '', stderr: '' };
  };
  assert.equal((await runTrayAction('start-open', f.context, { runCli })).ok, true);
  assert.equal(calls.includes('setup') || calls.includes('start'), false);
  calls.length = 0;
  assert.equal((await runTrayAction('open', f.context, { runCli })).ok, true);
  assert.deepEqual(calls, ['open', 'status']);
});

test('a failed start returns the observed degraded state, preserves data, and omits CLI stdout secrets', async t => {
  const f = await fixture(t);
  await configured(f);
  const calls = [];
  const result = await runTrayAction('start', f.context, { portBlocked: async () => false, runCli: async (context, args) => {
    calls.push(args[0]);
    return args[0] === 'status' ? reply({ status: 'degraded' })
      : { code: 1, stdout: 'Temporary access code: do-not-copy', stderr: '端口已占用 / Port already in use' };
  } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'degraded');
  assert.match(result.error, /Port already in use/);
  assert.equal(result.portBlocked, undefined, 'a port in use is not a Windows reservation');
  assert.doesNotMatch(JSON.stringify(result), /do-not-copy/);
  assert.deepEqual(calls, ['status', 'start', 'status']);
  assert.equal(existsSync(join(f.dataDir, 'graph-runtime.json')), true);
});

test('a start that fails on a port Windows reserves offers the port change', async t => {
  const f = await fixture(t);
  await configured(f);
  const checked = [];
  const result = await runTrayAction('start-open', f.context, {
    portBlocked: async (context) => { checked.push(context.dataDir); return true; },
    runCli: async (context, args) => args[0] === 'status' ? reply({ status: 'degraded' })
      : { code: 1, stdout: '', stderr: '端口 2727 被 Windows 保留（2634–2733），换一个端口即可。' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.portBlocked, true);
  assert.match(result.error, /被 Windows 保留（2634–2733）/);
  assert.deepEqual(checked, [f.dataDir]);
});

test('changing the port saves it first, restarts a running Fuli, opens it and says what to restart', async t => {
  const f = await fixture(t);
  await configured(f);
  const calls = [];
  const switched = [];
  const result = await runTrayAction('change-port', f.context, {
    switchPort: async (paths) => { switched.push(paths.runtimeSettingsPath); calls.push('switch'); return { previousPort: 2727, port: 2734 }; },
    runCli: async (context, args) => {
      calls.push(args[0]);
      return args[0] === 'status' ? reply(running) : { code: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(switched, [join(f.dataDir, 'runtime-settings.json')]);
  assert.deepEqual(calls, ['status', 'switch', 'restart', 'status', 'open', 'status']);
  assert.match(result.notice, /已改用端口 2734（原 2727）/);
  assert.match(result.notice, /until those sessions restart/);
});

test('changing the port of a console that failed to start starts it on the new port', async t => {
  const f = await fixture(t);
  await configured(f);
  const calls = [];
  let started = false;
  const result = await runTrayAction('change-port', f.context, {
    switchPort: async () => ({ previousPort: 2727, port: 2734 }),
    runCli: async (context, args) => {
      calls.push(args[0]);
      if (args[0] === 'start') started = true;
      return args[0] === 'status' ? reply(started ? running : { status: 'degraded' }) : { code: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['status', 'start', 'status', 'open', 'status']);
});

test('a port change that fails after saving still says which port is now configured', async t => {
  const f = await fixture(t);
  await configured(f);
  const result = await runTrayAction('change-port', f.context, {
    portBlocked: async () => { throw new Error('a port change does not check reservations again'); },
    switchPort: async () => ({ previousPort: 2727, port: 2734 }),
    runCli: async (context, args) => args[0] === 'status' ? reply({ status: 'degraded' })
      : { code: 1, stdout: '', stderr: 'Graphiti provider did not become ready' }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Graphiti provider did not become ready\n\n已改用端口 2734/);
  assert.equal(result.portBlocked, undefined);
});

test('the port change needs set-up native data and never writes settings otherwise', async t => {
  const f = await fixture(t);
  const switchPort = async () => { throw new Error('settings must not be written'); };
  const runCli = async () => reply(stopped);
  const unset = await runTrayAction('change-port', f.context, { switchPort, runCli });
  assert.equal(unset.ok, false);
  assert.match(unset.error, /not set up yet/);
  await configured(f, 'container');
  const container = await runTrayAction('change-port', f.context, { switchPort, runCli });
  assert.match(container.error, /will not switch/);
});

test('stop must confirm its final state; partial or still-running results never permit stop-and-exit', async t => {
  const f = await fixture(t);
  await configured(f);
  for (const code of [0, 1]) {
    const result = await runTrayAction('stop', f.context, { runCli: async (context, args) =>
      args[0] === 'status' ? reply({ status: 'degraded' }) : { code, stdout: 'partial', stderr: '' } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'degraded');
  }
  assert.equal((await runTrayAction('stop', f.context, { runCli: async (context, args) =>
    args[0] === 'status' ? reply(stopped) : { code: 0, stdout: '', stderr: '' } })).ok, true);
});

test('the tray refuses implicit conversion of existing container data', async t => {
  const f = await fixture(t);
  await configured(f, 'container');
  const calls = [];
  for (const action of ['start', 'start-open', 'stop']) {
    const result = await runTrayAction(action, f.context, { runCli: async (context, args) => {
      calls.push(args[0]); return reply(stopped);
    } });
    assert.equal(result.ok, false);
    assert.match(result.error, /will not switch/);
  }
  assert.deepEqual(calls, ['status', 'status', 'status']);
});

test('malformed or unknown status remains unknown; intentional sleep is reported truthfully', async t => {
  const f = await fixture(t);
  for (const stdout of ['not-json', '{"status":"surprise"}']) {
    const result = await runTrayAction('status', f.context, { runCli: async () => ({ code: 1, stdout, stderr: '' }) });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unknown');
  }
  assert.match(trayStateLabel({ status: 'running', adaptiveRuntime: { stage: 'provider-sleeping' } }), /Sleeping as configured/);
  await assert.rejects(runTrayAction('update', f.context), /Unsupported tray action/);
});

test('tray packaging replaces stale embedded Provider code but refuses dependency declaration drift', async t => {
  const f = await fixture(t);
  const source = join(f.root, 'checkout');
  const site = join(f.packageRoot, 'runtime', 'python', 'Lib', 'site-packages');
  const target = join(site, 'fuli_graph');
  await mkdir(join(source, 'graph-provider', 'fuli_graph'), { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(source, 'graph-provider', 'pyproject.toml'), 'same pinned dependencies');
  await writeFile(join(site, 'pyproject.toml'), 'same pinned dependencies');
  await writeFile(join(site, 'dependency.py'), 'preserved dependency');
  await writeFile(join(target, 'stale.py'), 'old removed application module');
  await writeFile(join(target, 'app.py'), 'old application');
  await writeFile(join(source, 'graph-provider', 'fuli_graph', 'app.py'), 'current application');
  const result = await refreshEmbeddedProvider(f.packageRoot, source);
  assert.equal(result.files, 1);
  assert.equal(await readFile(join(target, 'app.py'), 'utf8'), 'current application');
  assert.equal(existsSync(join(target, 'stale.py')), false);
  assert.equal(await readFile(join(site, 'dependency.py'), 'utf8'), 'preserved dependency');
  // A release bump alone keeps the dependencies and stamps the new Provider version.
  await mkdir(join(site, 'fuli_graph_provider-0.12.4.dist-info'), { recursive: true });
  await writeFile(join(site, 'fuli_graph_provider-0.12.4.dist-info', 'METADATA'), 'Name: fuli-graph-provider\nVersion: 0.12.4\n');
  await writeFile(join(site, 'pyproject.toml'), '[project]\nversion = "0.12.4"\ndependencies = ["x==1"]\n');
  await writeFile(join(source, 'graph-provider', 'pyproject.toml'), '[project]\nversion = "0.20.0rc1"\ndependencies = ["x==1"]\n');
  await refreshEmbeddedProvider(f.packageRoot, source);
  assert.match(await readFile(join(site, 'fuli_graph_provider-0.12.4.dist-info', 'METADATA'), 'utf8'), /^Version: 0\.20\.0rc1$/m);
  assert.match(await readFile(join(site, 'pyproject.toml'), 'utf8'), /0\.20\.0rc1/);
  await writeFile(join(source, 'graph-provider', 'pyproject.toml'), '[project]\nversion = "0.20.0rc1"\ndependencies = ["x==2"]\n');
  await assert.rejects(refreshEmbeddedProvider(f.packageRoot, source), /pyproject changed/);
  assert.equal(await readFile(join(target, 'app.py'), 'utf8'), 'current application');
});

test('tray asset reuse ignores only the root package version in the lockfile', async () => {
  const { dependencyLock } = await import('../scripts/build-windows-tray.js');
  const lock = version => Buffer.from(JSON.stringify({ name: 'fuli-context', version, lockfileVersion: 3,
    packages: { '': { name: 'fuli-context', version }, 'node_modules/zod': { version: '3.25.76' } } }));
  assert.deepEqual(dependencyLock(lock('0.12.4')), dependencyLock(lock('0.20.0-rc.1')));
  const changed = JSON.parse(lock('0.12.4'));
  changed.packages['node_modules/zod'].version = '3.25.77';
  assert.notDeepEqual(dependencyLock(lock('0.12.4')), dependencyLock(Buffer.from(JSON.stringify(changed))));
});

test('the tray package takes a complete desktop client build into client/, beside the launcher', async t => {
  const { copyDesktopClient } = await import('../scripts/build-windows-tray.js');
  const f = await fixture(t);
  const release = join(f.root, 'flutter-release');
  const output = join(f.root, 'tray-output');
  await mkdir(join(release, 'data', 'flutter_assets'), { recursive: true });
  await mkdir(output);
  for (const name of ['FULI.exe', 'flutter_windows.dll', 'tray_manager_plugin.dll', 'data/icudtl.dat']) await writeFile(join(release, name), name);
  await assert.rejects(copyDesktopClient(release, output), /incomplete; missing data\/app\.so/);
  assert.equal(existsSync(join(output, 'client')), false);
  await writeFile(join(release, 'data', 'app.so'), 'aot');
  await writeFile(join(release, 'data', 'flutter_assets', 'AssetManifest.bin'), 'assets');
  assert.equal(await copyDesktopClient(release, output), join(output, 'client'));
  for (const name of ['FULI.exe', 'tray_manager_plugin.dll', 'data/app.so', 'data/flutter_assets/AssetManifest.bin']) {
    assert.equal(await readFile(join(output, 'client', name), 'utf8'), await readFile(join(release, name), 'utf8'));
  }
  await assert.rejects(copyDesktopClient(release, join(release, 'nested')), /separate from the tray output/);
  // Another spelling of the same folder (a junction here; 8.3 short names on CI runners) is the same folder.
  const alias = join(f.root, 'release-alias');
  symlinkSync(release, alias, 'junction');
  await assert.rejects(copyDesktopClient(release, join(alias, 'nested')), /separate from the tray output/);
  await assert.rejects(copyDesktopClient(alias, join(release, 'nested')), /separate from the tray output/);
  await assert.rejects(copyDesktopClient('flutter-release', output), /absolute --client/);
});
