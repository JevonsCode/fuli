import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { compileWindowsNodeLauncher } from '../scripts/build-windows-tray.js';
import {
  WINDOWS_NODE_LAUNCHER, installedWindowsNodeLauncher, placeWindowsNodeLauncher, removeWindowsNodeLauncher
} from '../src/desktop/windows-node-launcher.js';

function temporaryRoot(t, prefix) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function packageWithLauncher(root, name, bytes) {
  const packageRoot = join(root, 'versions', name);
  mkdirSync(packageRoot, { recursive: true });
  if (bytes !== null) writeFileSync(join(packageRoot, WINDOWS_NODE_LAUNCHER), bytes);
  return packageRoot;
}

test('placing copies the installed version\'s launcher, keeps one a package lacks, and removal clears leftovers', t => {
  const root = temporaryRoot(t, 'fuli-node-launcher-place-');
  assert.equal(installedWindowsNodeLauncher(root), null);
  assert.equal(placeWindowsNodeLauncher(root, packageWithLauncher(root, 'old', null)), 'kept');
  assert.equal(installedWindowsNodeLauncher(root), null);
  assert.equal(placeWindowsNodeLauncher(root, packageWithLauncher(root, 'a', 'launcher 1')), 'replaced');
  assert.equal(installedWindowsNodeLauncher(root), join(root, WINDOWS_NODE_LAUNCHER));
  assert.equal(readFileSync(join(root, WINDOWS_NODE_LAUNCHER), 'utf8'), 'launcher 1');
  assert.equal(placeWindowsNodeLauncher(root, join(root, 'versions', 'a')), 'current');
  // A version from before D-77 leaves the launcher: it runs any version's installation.json.
  assert.equal(placeWindowsNodeLauncher(root, join(root, 'versions', 'old')), 'kept');
  assert.equal(readFileSync(join(root, WINDOWS_NODE_LAUNCHER), 'utf8'), 'launcher 1');
  const crashed = join(root, `${WINDOWS_NODE_LAUNCHER}.${randomUUID()}.new`);
  writeFileSync(crashed, 'partial');
  writeFileSync(join(root, 'unrelated.txt'), 'kept');
  assert.equal(placeWindowsNodeLauncher(root, packageWithLauncher(root, 'b', 'launcher 2')), 'replaced');
  assert.equal(readFileSync(join(root, WINDOWS_NODE_LAUNCHER), 'utf8'), 'launcher 2');
  assert.deepEqual(readdirSync(root).sort(), [WINDOWS_NODE_LAUNCHER, 'unrelated.txt', 'versions']);
  assert.deepEqual(removeWindowsNodeLauncher(root), []);
  assert.deepEqual(removeWindowsNodeLauncher(root), []);
  assert.deepEqual(readdirSync(root).sort(), ['unrelated.txt', 'versions']);
});

const compiler = process.env.SystemRoot
  && join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const canBuild = process.platform === 'win32' && process.arch === 'x64' && Boolean(compiler) && existsSync(compiler);

// An installation root as install and update leave it, with node and synthetic scripts per version.
function launcherInstallation(t) {
  const root = temporaryRoot(t, 'fuli-node-launcher-run-');
  const build = join(root, 'build');
  mkdirSync(build);
  return { root, build, async compile() {
    await compileWindowsNodeLauncher(compiler, build, build);
    return readFileSync(join(build, WINDOWS_NODE_LAUNCHER));
  }, slot(name, version) {
    const packageRoot = join(root, 'versions', name);
    mkdirSync(join(packageRoot, 'runtime', 'node'), { recursive: true });
    mkdirSync(join(packageRoot, 'src'), { recursive: true });
    const node = join(packageRoot, 'runtime', 'node', 'node.exe');
    try { linkSync(process.execPath, node); } catch { copyFileSync(process.execPath, node); }
    writeFileSync(join(packageRoot, 'src', 'probe.js'), `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2), input,
    cwd: process.cwd(), env: process.env.FULI_LAUNCHER_PROBE ?? null, script: process.argv[1], node: process.execPath }));
  process.stderr.write('probe stderr');
  process.exitCode = Number(process.env.FULI_LAUNCHER_EXIT ?? 0);
});
`);
    // Answers each line while stdin stays open, as an MCP server does.
    writeFileSync(join(packageRoot, 'src', 'linger.js'), 'process.stdout.write(String(process.pid) + "\\n");\n'
      + 'process.stdin.setEncoding("utf8").on("data", line => process.stdout.write("answer:" + line));\n');
    return packageRoot;
  }, record(packageRoot) {
    writeFileSync(join(root, 'installation.json'), JSON.stringify({ version: 1, status: 'installed', packageRoot }, null, 2));
  } };
}

const runLauncher = (launcher, args, options = {}) => spawnSync(launcher, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, ...options });

test('FuliNode.exe runs the recorded version with arguments, stdio, cwd, environment and exit code unchanged', { skip: !canBuild && 'needs the .NET Framework C# compiler on Windows x64' }, async t => {
  const f = launcherInstallation(t);
  const first = f.slot('a', '1.0.0');
  const second = f.slot('b', '1.0.1');
  placeWindowsNodeLauncher(f.root, packageWithLauncher(f.root, 'built', await f.compile()));
  const launcher = installedWindowsNodeLauncher(f.root);
  f.record(first);
  const cwd = join(f.root, 'working dir');
  mkdirSync(cwd);
  const args = ['with space', 'quote " inside', 'trailing\\', 'C:\\dir with space\\', '', '中文 ✓', '--flag=a&b|c^d%PATH%'];
  const input = JSON.stringify({ hook: 'UserPromptSubmit', prompt: '多行\n"quoted"\\' }) + '\n';
  const result = runLauncher(launcher, ['src\\probe.js', ...args], { input, cwd,
    env: { ...process.env, FULI_LAUNCHER_PROBE: 'passed', FULI_LAUNCHER_EXIT: '7' } });
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.stderr, 'probe stderr');
  const probe = JSON.parse(result.stdout);
  assert.deepEqual(probe, { version: '1.0.0', args, input, cwd, env: 'passed',
    script: join(first, 'src', 'probe.js'), node: join(first, 'runtime', 'node', 'node.exe') });
  // Update and rollback switch installation.json only; the same command runs the other version.
  f.record(second);
  assert.equal(JSON.parse(runLauncher(launcher, ['src/probe.js'], { input: '' }).stdout).version, '1.0.1');
  // A package or slot copy without an installation.json beside it runs its own folder.
  copyFileSync(launcher, join(first, WINDOWS_NODE_LAUNCHER));
  assert.equal(JSON.parse(runLauncher(join(first, WINDOWS_NODE_LAUNCHER), ['src\\probe.js'], { input: '' }).stdout).version, '1.0.0');
});

test('FuliNode.exe refuses scripts outside the version and records naming another folder', { skip: !canBuild && 'needs the .NET Framework C# compiler on Windows x64' }, async t => {
  const f = launcherInstallation(t);
  const slot = f.slot('a', '1.0.0');
  placeWindowsNodeLauncher(f.root, packageWithLauncher(f.root, 'built', await f.compile()));
  const launcher = installedWindowsNodeLauncher(f.root);
  f.record(slot);
  writeFileSync(join(f.root, 'outside.js'), 'process.stdout.write("ran")');
  for (const [args, message] of [[[], /Usage/], [[join(slot, 'src', 'probe.js')], /relative to the FULI package/],
    [['..\\..\\outside.js'], /outside the FULI package/], [['src\\missing.js'], /has no src\\missing\.js/]]) {
    const result = runLauncher(launcher, args, { input: '' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
  }
  f.record(f.root);
  assert.match(runLauncher(launcher, ['src\\probe.js'], { input: '' }).stderr, /version outside/);
  writeFileSync(join(f.root, 'installation.json'), '{ not json');
  assert.match(runLauncher(launcher, ['src\\probe.js'], { input: '' }).stderr, /cannot be read/);
});

test('ending FuliNode.exe ends node, and a running launcher is replaced by moving it aside', { skip: !canBuild && 'needs the .NET Framework C# compiler on Windows x64' }, async t => {
  const f = launcherInstallation(t);
  const slot = f.slot('a', '1.0.0');
  const built = await f.compile();
  placeWindowsNodeLauncher(f.root, packageWithLauncher(f.root, 'built', built));
  f.record(slot);
  const child = spawn(installedWindowsNodeLauncher(f.root), ['src\\linger.js'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => child.kill());
  const pid = Number((await new Promise(resolve => child.stdout.once('data', resolve))).toString().trim());
  assert.ok(Number.isInteger(pid) && pid !== child.pid);
  child.stdin.write('{"jsonrpc":"2.0","id":1}\n');
  assert.equal((await new Promise(resolve => child.stdout.once('data', resolve))).toString(), 'answer:{"jsonrpc":"2.0","id":1}\n');
  // An update while a client runs the launcher: the running program is renamed, not overwritten.
  const changed = Buffer.concat([built, Buffer.from('changed')]);
  assert.equal(placeWindowsNodeLauncher(f.root, packageWithLauncher(f.root, 'next', changed)), 'replaced');
  assert.deepEqual(readFileSync(join(f.root, WINDOWS_NODE_LAUNCHER)), changed);
  assert.equal(readdirSync(f.root).filter(name => name.endsWith('.old')).length, 1);
  assert.equal(removeWindowsNodeLauncher(f.root).length, 1, 'the running launcher is reported until it exits');
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
  for (let attempt = 0; attempt < 50 && alive(pid); attempt++) await delay(100);
  assert.equal(alive(pid), false, 'node ends with its launcher');
  for (let attempt = 0; attempt < 50 && removeWindowsNodeLauncher(f.root).length; attempt++) await delay(100);
  assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith(WINDOWS_NODE_LAUNCHER)), []);
  assert.equal(dirname(slot), join(f.root, 'versions'));
});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
