import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isMainModule } from '../src/system/main-module.js';
import { DEFAULT_RUNTIME_SETTINGS, PORT_KEYS, writeRuntimeSettings } from '../src/system/runtime-settings.js';

// CI's check of a built FULI .dmg (.github/workflows/desktop-client.yml):
// mount it, copy FULI.app out as a person would, and start FULI the way the
// desktop client does (macos-controller.js on the bundled Node) with a
// temporary HOME, ephemeral ports, and a PATH with no Node, Java, Python or uv,
// then check the console answers, stop it, and launch the client itself.

const CONTROLLER_TIMEOUT_MS = 15 * 60_000;
const CLIENT_SETTLE_MS = 15_000;
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

async function smokeMacosDmg(dmg) {
  if (process.platform !== 'darwin') throw new Error('Run the macOS app smoke test on macOS.');
  if (typeof dmg !== 'string' || !isAbsolute(dmg) || !existsSync(dmg)) throw new Error('Pass the absolute path of the .dmg.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fuli-macos-smoke-')));
  const mount = join(root, 'volume');
  const app = join(root, 'Applications', 'FULI.app');
  const home = join(root, 'home');
  const dataDir = join(home, 'Library', 'Application Support', 'Fuli');
  const env = { HOME: home, PATH: SYSTEM_PATH, LANG: 'en_US.UTF-8', TMPDIR: join(root, 'tmp') };
  const packageRoot = join(app, 'Contents', 'Resources', 'fuli');
  const controller = action => command(join(packageRoot, 'runtime', 'node', 'bin', 'node'),
    [join(packageRoot, 'src', 'desktop', 'macos-controller.js'), action], { env, cwd: packageRoot });
  let started = false;
  try {
    await mkdir(mount, { recursive: true });
    await mkdir(env.TMPDIR, { recursive: true });
    await command('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mount]);
    try {
      assert.ok(existsSync(join(mount, 'Applications')), 'The image offers the Applications folder to drag to.');
      await mkdir(join(root, 'Applications'));
      await command('/usr/bin/ditto', [join(mount, 'FULI.app'), app]);
    } finally {
      await command('/usr/bin/hdiutil', ['detach', mount]);
    }
    await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    step('FULI.app copied out of the image; its signature verifies');

    const ports = Object.fromEntries(await Promise.all(PORT_KEYS.map(async key => [key, await freePort()])));
    await mkdir(dataDir, { recursive: true });
    writeRuntimeSettings(join(dataDir, 'runtime-settings.json'),
      { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native', ports });

    const before = reply(await controller('status'));
    assert.equal(before.status, 'not_configured', JSON.stringify(before));
    started = true;
    const start = reply(await controller('start'));
    if (!start.ok) {
      // The controller keeps the CLI's stdout to itself; setup again shows what it reported.
      const again = await command(join(packageRoot, 'runtime', 'node', 'bin', 'node'), [join(packageRoot, 'src', 'cli.js'),
        'setup', '--yes', '--skip-agents', '--personal-only', '--runtime-mode', 'native', '--data-dir', dataDir],
      { env, cwd: packageRoot }).catch(error => ({ stdout: '', stderr: error.message }));
      process.stdout.write('--- setup again\n' + again.stdout + '\n' + again.stderr + '\n');
    }
    assert.equal(start.ok, true, 'start failed: ' + start.error);
    assert.equal(start.status, 'running');
    step('First start set FULI up in native mode from the bundled runtime and reached running');

    const health = await fetch(`http://127.0.0.1:${ports.console}/api/health`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(health.status, 200);
    const manifest = JSON.parse(await readFile(join(dataDir, 'native-runtime', 'manifest.json'), 'utf8'));
    assert.ok(manifest.javaHome.startsWith(packageRoot) && manifest.providerPython.startsWith(packageRoot),
      'Java and the Provider run from the app');
    assert.ok(manifest.neo4jHome.startsWith(dataDir), 'Neo4j is unpacked into the data directory');
    step('The console answers on its port; Java and Python come from FULI.app, Neo4j from the data directory');

    const stop = reply(await controller('stop'));
    assert.equal(stop.ok, true, 'stop failed: ' + stop.error);
    started = false;
    step('Stop confirmed: ' + stop.status);

    await launchClient(app, { ...env, FULI_DATA_DIR: dataDir });
    step('The desktop client launches and keeps running');
  } catch (error) {
    await printLogs(dataDir);
    throw error;
  } finally {
    if (started) await controller('stop').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function launchClient(app, env) {
  const child = spawn(join(app, 'Contents', 'MacOS', 'FULI'), [], { env, stdio: 'ignore' });
  let exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  await delay(CLIENT_SETTLE_MS);
  try {
    assert.equal(exit, null, 'The desktop client exited: ' + JSON.stringify(exit));
  } finally {
    child.kill();
  }
}

function reply(result) {
  const line = result.stdout.trim().split('\n').filter(text => text.startsWith('{')).pop();
  assert.ok(line, 'The controller printed no result: ' + result.stderr);
  return JSON.parse(line);
}

function command(file, args, { env = process.env, cwd } = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { env, cwd, encoding: 'utf8',
    timeout: CONTROLLER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    // The controller reports a failed action in its JSON line with exit code 1.
    if (error && typeof error.code !== 'number') reject(error);
    else if (error && !stdout.trim().startsWith('{')) reject(new Error(file + ' failed: ' + (stderr || stdout).slice(-4000)));
    else resolve({ stdout, stderr });
  }));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function printLogs(dataDir) {
  for (const directory of [join(dataDir, 'logs'), join(dataDir, 'native-runtime', 'personal', 'logs')]) {
    const names = await readdir(directory).catch(() => []);
    for (const name of names) {
      const text = await readFile(join(directory, name), 'utf8').catch(() => '');
      process.stdout.write(`\n--- ${join(directory, name)} (last 4000 characters)\n${text.slice(-4000)}\n`);
    }
  }
}

const step = message => process.stdout.write('PASS ' + message + '\n');

if (isMainModule(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/macos-app-smoke.js <absolute .dmg path>');
    await smokeMacosDmg(process.argv[2]);
  } catch (error) { process.stderr.write((error.stack ?? error.message) + '\n'); process.exitCode = 1; }
}
