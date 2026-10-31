// Run on Windows: set SMOKE_ROOT to a fresh directory directly under TEMP, then
// `node acceptance/windows-installed-update.js prepare`, build the release with
// .github/actions/windows-tray, `... update <release-directory>`, and `... stop`.
// The script never uses the user's FULI installation, data or client profiles.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256File } from '../src/security/digest.js';
import { compareSemanticVersions, parseSemanticVersion } from '../src/semantic-version.js';
import { DEFAULT_RUNTIME_SETTINGS, PORT_KEYS } from '../src/system/runtime-settings.js';
import { isMainModule } from '../src/system/main-module.js';

const exec = promisify(execFile);
const TIMEOUT = 15 * 60_000;
const REPO = 'JevonsCode/fuli';
let smokeLog;

export function previousRelease(pages) {
  const releases = pages.flat().filter(release => !release.draft && release.published_at)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  for (const release of releases) {
    const version = release.tag_name?.replace(/^v/, '');
    try { parseSemanticVersion(version); } catch { continue; }
    const archive = `fuli-windows-tray-${version}.zip`;
    if (release.assets.some(asset => asset.name === archive)) return { tag: release.tag_name, version, archive };
  }
  throw new Error('No published release has a versioned Windows tray zip.');
}

export function checksumDigest(text, archive) {
  const match = /^([a-f0-9]{64}) [ *]([^\r\n]+)\s*$/i.exec(text);
  if (!match || match[2] !== archive) throw new Error('Invalid published checksum or archive name.');
  return match[1].toLowerCase();
}

async function main() {
  assert.equal(process.platform, 'win32', 'Run this acceptance test on Windows.');
  const root = resolve(process.env.SMOKE_ROOT ?? '');
  assert.equal(dirname(root).toLowerCase(), resolve(tmpdir()).toLowerCase(), 'SMOKE_ROOT must be a fresh direct child of TEMP.');
  assert.equal(basename(root), 'fuli-update', 'Use the dedicated smoke directory name.');
  smokeLog = join(root, 'smoke.log');
  const data = join(root, 'data'), install = join(root, 'install'), stateFile = join(root, 'state.json');
  const home = join(root, 'user');
  // Do not inherit client or FULI overrides from the caller during setup/reconnect.
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
    PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec,
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), HOME: home, USERPROFILE: home,
    LOCALAPPDATA: join(home, 'Local'), APPDATA: join(home, 'Roaming'),
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, 'config'), FULI_DATA_DIR: join(root, 'decoy') };
  const log = async line => { console.log(line); await appendFile(join(root, 'smoke.log'), line + '\n'); };
  const run = async (file, args, options = {}) => {
    await log(`Running ${basename(file)} ${args.join(' ')}`);
    try {
      const result = await exec(file, args, { cwd: root, env, windowsHide: true, timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024, ...options });
      await appendFile(join(root, 'smoke.log'), result.stdout + result.stderr);
      return result.stdout;
    } catch (error) {
      await appendFile(join(root, 'smoke.log'), (error.stdout ?? '') + (error.stderr ?? '') + error.message + '\n');
      throw error;
    }
  };
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const controller = async action => {
    const record = await json(join(install, 'installation.json'));
    const packageRoot = realpathSync(record.packageRoot);
    const versions = realpathSync(join(install, 'versions'));
    const actualRoot = realpathSync(root);
    for (const path of [versions, realpathSync(data)]) {
      const inside = relative(actualRoot, path);
      assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside), 'Installation and data must remain inside the isolated directory.');
    }
    const slot = relative(versions, packageRoot);
    assert.ok(slot && !slot.startsWith('..') && !isAbsolute(slot), 'Installed package must be inside the isolated versions directory.');
    assert.equal(realpathSync(record.dataDir).toLowerCase(), realpathSync(data).toLowerCase(), 'Installation must use the isolated data directory.');
    const output = await run(join(packageRoot, 'runtime/node/node.exe'), [join(packageRoot, 'src/desktop/windows-controller.js'), action]);
    const result = JSON.parse(output);
    assert.equal(result.ok, true, result.error);
  };
  const phase = process.argv[2];
  if (phase === 'prepare') {
    assert.equal(existsSync(root), false, 'SMOKE_ROOT already exists; choose a fresh TEMP directory.');
    await mkdir(root);
    await mkdir(home);
    await mkdir(join(root, 'tmp'));
    const releases = JSON.parse(await run('gh.exe', ['api', '--paginate', '--slurp', `repos/${REPO}/releases?per_page=100`], { env: process.env }));
    const previous = previousRelease(releases);
    const version = (await json(resolve('package.json'))).version;
    const comparison = compareSemanticVersions(version, previous.version);
    if (comparison === 0) {
      await log(`Skipped: checkout and latest published tray are both ${version}; an update requires a newer version.`);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `Installed update skipped: checkout and latest tray are both ${version}.\n`);
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'update_available=false\n');
      return;
    }
    assert.ok(comparison > 0, `Checkout ${version} is older than published tray ${previous.version}.`);
    const download = join(root, 'download'), source = join(root, 'previous');
    await mkdir(download); await mkdir(source);
    await run('gh.exe', ['release', 'download', previous.tag, '--repo', REPO, '--dir', download,
      '--pattern', previous.archive, '--pattern', previous.archive + '.sha256'], { env: process.env });
    const archive = join(download, previous.archive);
    assert.equal(await sha256File(archive), checksumDigest(await readFile(archive + '.sha256', 'utf8'), previous.archive));
    await run(join(process.env.SystemRoot, 'System32/tar.exe'), ['-xf', archive, '-C', source]);
    assert.equal((await json(join(source, 'package.json'))).version, previous.version);
    for (const name of ['desktop', 'start-menu']) await mkdir(join(root, name));
    await run(join(source, 'runtime/node/node.exe'), [join(source, 'src/desktop/windows-install.js'), '--yes',
      '--install-root', install, '--data-dir', data, '--desktop-dir', join(root, 'desktop'), '--start-menu-dir', join(root, 'start-menu')]);
    const ports = {};
    for (const key of PORT_KEYS) {
      do { ports[key] = await freePort(); } while ([2727, 2828].includes(ports[key]) || Object.values(ports).filter(port => port === ports[key]).length > 1);
    }
    await mkdir(data);
    await writeFile(join(data, 'runtime-settings.json'), JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native', ports }));
    await writeFile(join(data, 'adaptive-runtime-settings.json'), JSON.stringify({ version: 1, enabled: false }));
    await writeFile(join(data, 'graph-provider.env'), 'FULI_NEO4J_MEMORY_PROFILE=low\n');
    await writeFile(stateFile, JSON.stringify({ ports, version }));
    await controller('start');
    await waitHealth(ports.console, previous.version);
    await log(`Previous release ${previous.version} is ready on ${ports.console}.`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'update_available=true\n');
  } else if (phase === 'update') {
    const state = await json(stateFile);
    const releaseDir = resolve(process.argv[3]);
    const archive = join(releaseDir, `fuli-windows-tray-${state.version}.zip`);
    assert.equal(await sha256File(archive), checksumDigest(await readFile(archive + '.sha256', 'utf8'), basename(archive)));
    const candidate = join(root, 'candidate'); await mkdir(candidate);
    await run(join(process.env.SystemRoot, 'System32/tar.exe'), ['-xf', archive, '-C', candidate]);
    assert.equal((await json(join(candidate, 'package.json'))).version, state.version);
    await run(join(candidate, 'runtime/node/node.exe'), [join(candidate, 'src/desktop/windows-update-command.js'), '--yes', '--install-root', install]);
    assert.equal((await json(join(install, 'installation.json'))).applicationVersion, state.version);
    await waitHealth(state.ports.console, state.version);
    await handshake(join(install, 'FuliNode.exe'), join(data, 'graph-runtime.json'), state.version, env, root);
    await log(`Updated ${state.version}: health and stable-launcher MCP initialize passed.`);
  } else if (phase === 'stop') {
    if (existsSync(stateFile) && existsSync(join(install, 'installation.json'))) { await controller('stop'); await log('Isolated installation stopped.'); }
  } else throw new Error('Expected prepare, update <release-directory>, or stop.');
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function waitHealth(port, version) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      const health = await response.json();
      if (response.ok && health.status === 'ready' && health.service === 'fuli-local-console' && health.version === version) return;
    } catch { /* Wait for the installed console. */ }
    await delay(1000);
  }
  throw new Error(`Console did not become ready on ${port} with version ${version}.`);
}

async function handshake(launcher, config, version, env, cwd) {
  const child = spawn(launcher, ['src/mcp-server.js', '--runtime-config', config, '--source-application', 'other', '--tool-profile', 'chat'],
    { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const result = await new Promise((resolveResult, reject) => {
      let stdout = '', stderr = '';
      const timer = setTimeout(() => reject(new Error('MCP initialize timed out: ' + stderr)), 60_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`MCP exited before initialize (${code}): ${stderr}`)); });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const lines = stdout.split('\n'); stdout = lines.pop();
        for (const line of lines) {
          try { const message = JSON.parse(line); if (message.id === 1) { clearTimeout(timer); resolveResult(message); } }
          catch (error) { clearTimeout(timer); reject(error); }
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'installed-update-smoke', version: '1' }
      } }) + '\n');
    });
    assert.equal(result.result?.serverInfo?.version, version, JSON.stringify(result));
  } finally { child.kill(); }
}

if (isMainModule(import.meta.url)) {
  main().catch(async error => {
    console.error(error);
    if (smokeLog && existsSync(smokeLog)) await appendFile(smokeLog, String(error.stack ?? error) + '\n');
    process.exitCode = 1;
  });
}
