import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Steps the Windows portable bundle (build-windows-portable.js) and the macOS
// app (build-macos-app.js) share: the current application with its production
// dependencies, checksum-pinned downloads, the Provider wheel and a file
// inventory. Build tools may use the developer's Node/Python; the output may not.

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const progress = message => process.stdout.write(message + '\n');

export function buildEnvironment(pipConfigFile) {
  return { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONNOUSERSITE: '1',
    PIP_INDEX_URL: 'https://pypi.org/simple', PIP_EXTRA_INDEX_URL: '', PIP_CONFIG_FILE: pipConfigFile,
    npm_config_audit: 'false', npm_config_fund: 'false' };
}

export function run(command, args, { cwd, env = process.env, capture = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = execFile(command, args, { cwd, env, windowsHide: true, timeout: 20 * 60_000,
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error('Build command failed (' + error.code + '): ' + (stderr || stdout).slice(-4000)));
      else resolveRun(stdout);
    });
    if (!capture) { child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); }
  });
}

// `npm run build`, `npm pack` of this checkout unpacked into output, then its
// production dependencies without install scripts. tar: the platform's tar.
export async function packCurrentApplication({ output, scratch, env, tar }) {
  // npm sits beside node.exe on Windows and under <prefix>/lib elsewhere.
  const npm = [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(existsSync);
  if (!npm) throw new Error('npm was not found beside the Node running the build.');
  progress('Building application and web assets');
  await run(process.execPath, [npm, 'run', 'build'], { cwd: PACKAGE_ROOT, env, capture: true });
  const packed = JSON.parse(await run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json',
    '--pack-destination', scratch], { cwd: PACKAGE_ROOT, env, capture: true }))[0];
  await run(tar, ['-xzf', join(scratch, packed.filename), '-C', scratch]);
  await cp(join(scratch, 'package'), output, { recursive: true, dereference: true });
  progress('Vendoring production Node dependencies');
  await run(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts'], { cwd: output, env, capture: true });
}

// A pinned archive in cacheDir, downloaded once and checked on every use.
export async function pinnedArchive(artifact, cacheDir, name) {
  progress('Checking pinned ' + name + ' archive');
  const archive = join(cacheDir, artifact.filename);
  if (!existsSync(archive)) {
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error('Download failed: ' + artifact.url + ' HTTP ' + response.status);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  }
  assert.equal(sha256(await readFile(archive)), artifact.sha256, name + ' archive checksum mismatch');
  return archive;
}

// A non-editable wheel of graph-provider/ built by `python`.
export async function buildProviderWheel(python, wheels, env) {
  await mkdir(wheels, { recursive: true });
  await run(python, ['-m', 'pip', 'wheel', '--quiet', '--no-deps', '--wheel-dir', wheels,
    join(PACKAGE_ROOT, 'graph-provider')], { env });
  const wheel = (await readdir(wheels)).find(name => name.startsWith('fuli_graph_provider-') && name.endsWith('.whl'));
  if (!wheel) throw new Error('Provider wheel was not built.');
  return join(wheels, wheel);
}

// After `pip install --report`: pip's host-specific direct_url metadata goes,
// the Provider's pyproject.toml comes in (its fingerprint and version source),
// and the report becomes the inventory's list of installed Python packages.
export async function finishProviderSite(site, reportPath, wheel) {
  for (const name of (await readdir(site)).filter(name => name.endsWith('.dist-info'))) {
    await rm(join(site, name, 'direct_url.json'), { force: true });
  }
  await cp(join(PACKAGE_ROOT, 'graph-provider', 'pyproject.toml'), join(site, 'pyproject.toml'));
  const wheelName = wheel.split(/[\\/]/).pop();
  return JSON.parse(await readFile(reportPath, 'utf8')).install.map(item => ({
    name: item.metadata.name, version: item.metadata.version, license: item.metadata.license ?? null,
    source: item.download_info.url.startsWith('file:') ? wheelName : item.download_info.url,
    sha256: item.download_info.archive_info?.hashes?.sha256 ?? null
  }));
}

export async function hashTree(root, prefix = '') {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...await hashTree(join(root, entry.name), name));
    else if (entry.isFile()) files.push([name, sha256(await readFile(join(root, entry.name)))]);
  }
  return files;
}
