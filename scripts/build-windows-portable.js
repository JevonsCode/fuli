import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../src/system/main-module.js';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../src/native-runtime/windows-assets.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOWNLOADS = {
  node: { filename: 'node-v24.18.0-win-x64.zip',
    url: 'https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip',
    sha256: '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821',
    checksumSource: 'https://nodejs.org/dist/v24.18.0/SHASUMS256.txt' },
  python: { filename: 'python-3.12.10-embed-amd64.zip',
    url: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip',
    sha256: '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3',
    checksumSource: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip.sigstore' }
};

// Build tools may use the developer's Node/Python. The output may not.
export async function buildWindowsPortable({ output, assetRoot, buildPython, cacheDir }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64.');
  for (const [key, value] of Object.entries({ output, assetRoot, buildPython, cacheDir })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Missing --' + key);
  }
  output = resolve(output);
  assetRoot = resolve(assetRoot);
  cacheDir = resolve(cacheDir);
  if (existsSync(output) && (await readdir(output)).length) throw new Error('Output must be a new or empty directory.');
  const inside = (root, path) => { const local = relative(root, path); return !isAbsolute(local) && !local.startsWith('..'); };
  if ([output, cacheDir].some(path => inside(PACKAGE_ROOT, path) || inside(assetRoot, path))) {
    throw new Error('Output must be outside the source checkout and supplied assets.');
  }
  const assetBefore = await Promise.all(['neo4j', 'jre21'].map(name => hashTree(join(assetRoot, name))));
  const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const env = { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONNOUSERSITE: '1',
    PIP_INDEX_URL: 'https://pypi.org/simple', PIP_EXTRA_INDEX_URL: '', PIP_CONFIG_FILE: 'NUL',
    npm_config_audit: 'false', npm_config_fund: 'false' };
  await mkdir(output, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  const scratch = await mkdtemp(join(cacheDir, 'build-'));
  try {
    progress('Building application and web assets');
    await run(process.execPath, [npm, 'run', 'build'], { cwd: PACKAGE_ROOT, env, capture: true });
    const packed = JSON.parse(await run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json',
      '--pack-destination', scratch], { cwd: PACKAGE_ROOT, env, capture: true }))[0];
    await run(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xzf', join(scratch, packed.filename), '-C', scratch]);
    await cp(join(scratch, 'package'), output, { recursive: true, dereference: true });
    progress('Vendoring production Node dependencies');
    await run(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts'], { cwd: output, env, capture: true });

    const archives = {};
    for (const [key, artifact] of Object.entries(DOWNLOADS)) {
      progress('Checking pinned ' + key + ' archive');
      const archive = join(cacheDir, artifact.filename);
      if (!existsSync(archive)) {
        const response = await fetch(artifact.url, { signal: AbortSignal.timeout(300_000) });
        if (!response.ok) throw new Error('Download failed: ' + artifact.url + ' HTTP ' + response.status);
        await writeFile(archive, Buffer.from(await response.arrayBuffer()));
      }
      assert.equal(sha256(await readFile(archive)), artifact.sha256, key + ' archive checksum mismatch');
      archives[key] = archive;
    }
    const runtime = join(output, 'runtime');
    await mkdir(runtime, { recursive: true });
    await expandZip(archives.node, join(scratch, 'node'));
    await cp(join(scratch, 'node', 'node-v24.18.0-win-x64'), join(runtime, 'node'), { recursive: true });
    // npm is a build tool; the portable runtime never installs packages on first run.
    await rm(join(runtime, 'node', 'node_modules'), { recursive: true, force: true });
    for (const file of ['npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1', 'corepack', 'corepack.cmd']) {
      await rm(join(runtime, 'node', file), { force: true });
    }
    await expandZip(archives.python, join(runtime, 'python'));
    progress('Copying read-only Neo4j and jlink JRE assets');
    await cp(join(assetRoot, 'neo4j'), join(runtime, 'neo4j'), { recursive: true, dereference: true,
      filter: source => !['data', 'logs', 'run', 'certificates'].includes(relative(join(assetRoot, 'neo4j'), source).split(/[\\/]/)[0]) });
    await cp(join(assetRoot, 'jre21'), join(runtime, 'jre21'), { recursive: true, dereference: true });

    progress('Building a non-editable Provider wheel and vendoring dependencies');
    const wheels = join(scratch, 'wheels');
    await mkdir(wheels);
    await run(buildPython, ['-m', 'pip', 'wheel', '--quiet', '--no-deps', '--wheel-dir', wheels,
      join(PACKAGE_ROOT, 'graph-provider')], { env });
    const wheel = (await readdir(wheels)).find(name => name.startsWith('fuli_graph_provider-') && name.endsWith('.whl'));
    if (!wheel) throw new Error('Provider wheel was not built.');
    const site = join(runtime, 'python', 'Lib', 'site-packages');
    const reportPath = join(scratch, 'python-install.json');
    await run(buildPython, ['-m', 'pip', 'install', '--quiet', '--only-binary=:all:', '--no-compile', '--target', site,
      '--report', reportPath, join(wheels, wheel)], { env });
    // pip creates host-specific executable wrappers and direct_url metadata.
    // Runtime uses python -m uvicorn and the bundled wheel's package files.
    for (const name of ['bin', 'Scripts']) await rm(join(site, name), { recursive: true, force: true });
    for (const name of (await readdir(site)).filter(name => name.endsWith('.dist-info'))) {
      await rm(join(site, name, 'direct_url.json'), { force: true });
    }
    await cp(join(PACKAGE_ROOT, 'graph-provider', 'pyproject.toml'), join(site, 'pyproject.toml'));
    await writeFile(join(runtime, 'python', 'python312._pth'), 'python312.zip\n.\nLib/site-packages\nimport site\n');
    const pythonPackages = JSON.parse(await readFile(reportPath, 'utf8')).install.map(item => ({
      name: item.metadata.name, version: item.metadata.version, license: item.metadata.license ?? null,
      source: item.download_info.url.startsWith('file:') ? wheel : item.download_info.url,
      sha256: item.download_info.archive_info?.hashes?.sha256 ?? null
    }));
    const python = join(runtime, 'python', 'python.exe');
    const probe = JSON.parse(await run(python, ['-I', '-B', '-c',
      'import json,sys,fuli_graph,graphiti_core,neo4j,uvicorn; print(json.dumps({"prefix":sys.prefix,"base_prefix":sys.base_prefix,"isolated":sys.flags.isolated,"user_site":sys.flags.no_user_site,"provider":fuli_graph.__file__}))'], { capture: true, env }));
    assert.equal(resolve(probe.prefix), join(runtime, 'python'));
    assert.equal(probe.prefix, probe.base_prefix, 'Embedded Python must not depend on a venv home');
    assert.equal(probe.isolated, 1);
    assert.equal(probe.user_site, 1);
    assert.ok(resolve(probe.provider).startsWith(site + '\\'));

    const manifest = { version: 1, platform: 'win32', arch: 'x64', providerPackaging: 'embedded',
      neo4jHome: 'runtime/neo4j', javaHome: 'runtime/jre21', providerPython: 'runtime/python/python.exe',
      providerSource: 'runtime/python/Lib/site-packages', dataDir: 'data' };
    await writeFile(join(output, 'native-bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
    const resolvedBundle = resolveWindowsNativeBundle(readWindowsNativeBundle(output));
    await writeFile(join(output, 'fuli.cmd'), '@echo off\r\n"%~dp0runtime\\node\\node.exe" "%~dp0src\\cli.js" %*\r\n');
    await writeFile(join(output, 'fl.cmd'), '@echo off\r\n"%~dp0runtime\\node\\node.exe" "%~dp0src\\cli.js" %*\r\n');
    const inventory = { version: 1, applicationVersion: JSON.parse(await readFile(join(output, 'package.json'), 'utf8')).version,
      status: 'local-candidate', downloads: DOWNLOADS, pythonPackages,
      versions: { node: '24.18.0', python: '3.12.10', neo4j: resolvedBundle.neo4jVersion, java: resolvedBundle.javaVersion },
      suppliedAssets: ['neo4j', 'jre21'].map((name, index) => ({ name,
        source: 'provided read-only .tools/' + name, fileCount: assetBefore[index].length,
        sha256Tree: sha256(JSON.stringify(assetBefore[index])), licenses: name === 'neo4j'
          ? ['runtime/neo4j/LICENSE.txt', 'runtime/neo4j/LICENSES.txt', 'runtime/neo4j/NOTICE.txt', 'runtime/neo4j/licenses']
          : ['runtime/jre21/legal', 'runtime/jre21/release'] })) };
    await writeFile(join(output, 'portable-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
    await writeFile(join(output, 'PORTABLE.md'), portableInstructions(inventory.applicationVersion));
    await writeFile(join(output, 'THIRD_PARTY_NOTICES.md'), thirdPartyNotices());
    assert.deepEqual(await Promise.all(['neo4j', 'jre21'].map(name => hashTree(join(assetRoot, name)))), assetBefore,
      'Supplied assets must remain unchanged');
    const files = await hashTree(output);
    await writeFile(join(output, 'portable-files.sha256.json'), JSON.stringify(files, null, 2) + '\n');
    progress('Local candidate complete: ' + output + ' (' + files.length + ' files)');
    return { output, files: files.length, pythonPackages: pythonPackages.length };
  } finally {
    assert.equal(dirname(scratch), cacheDir);
    await rm(scratch, { recursive: true, force: true });
  }
}

async function hashTree(root, prefix = '') {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...await hashTree(join(root, entry.name), name));
    else files.push([name, sha256(await readFile(join(root, entry.name)))]);
  }
  return files;
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const progress = message => process.stdout.write(message + '\n');

async function expandZip(archive, destination) {
  await mkdir(destination, { recursive: true });
  await run(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', archive, '-C', destination]);
}

function run(command, args, { cwd, env = process.env, capture = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = execFile(command, args, { cwd, env, windowsHide: true, timeout: 20 * 60_000,
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error('Build command failed (' + error.code + '): ' + (stderr || stdout).slice(-4000)));
      else resolveRun(stdout);
    });
    if (!capture) { child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); }
  });
}

function portableInstructions(version) {
  return `# Fuli ${version} Windows 本地候选目录包\n\n` +
    '这是 Windows x64 便携候选目录，不是系统安装器或桌面托盘。无需 Docker、WSL、系统 Node、Python、Java 或 uv。Windows 自带 PowerShell/CIM 与系统 C Runtime 仍是平台前提。\n\n' +
    '在此目录运行：\n\n```powershell\n.\\fuli.cmd setup --yes --skip-agents --personal-only --runtime-mode native\n.\\fuli.cmd status --json\n.\\fuli.cmd stop\n.\\fuli.cmd start\n```\n\n' +
    'native-bundle.json 的路径全部相对于包目录；默认数据保存在 data/。显式 --data-dir 优先于 FULI_DATA_DIR，再优先于包内 data/。普通 npm 安装继续使用原平台数据目录。\n\n' +
    '搬移前先 stop，确认 status 已停止并且所有 owned 进程退出，再整体搬移目录。app/runtime 资产与 data/ 一起搬移；也可通过 --data-dir 指定独立数据目录并单独保留它。首次启动会重解析当前包路径。不要在运行中搬移或复制图数据。\n\n' +
    '移除候选时默认保留数据：先 stop；备份并保留 data/ 或外部数据目录，再删除程序资产与 launcher。本候选只验收此手动移除策略，未验收系统卸载程序；不要通过 uninstall 命令影响日常客户端集成。验收 setup 使用 --skip-agents，不改全局客户端配置。\n\n' +
    'portable-inventory.json 记录固定下载来源、SHA256、Provider 依赖版本和资产许可证；portable-files.sha256.json 是构建时文件树，不含运行后的 data/。\n';
}

function thirdPartyNotices() {
  return '# Included third-party components\n\n' +
    '- Fuli: LICENSE and package.json.\n' +
    '- Node.js 24.18.0: runtime/node/LICENSE, official Node.js binary archive.\n' +
    '- CPython 3.12.10 embeddable: runtime/python/LICENSE.txt; official Python.org archive.\n' +
    '- Neo4j Community 5.26.0: runtime/neo4j/LICENSE.txt, LICENSES.txt, NOTICE.txt and licenses/.\n' +
    '- Provided Eclipse Temurin Java 21 jlink image: runtime/jre21/release and legal/ (included image provenance, not a newly downloaded JDK).\n' +
    '- Python/Graphiti dependencies: runtime/python/Lib/site-packages/*.dist-info metadata/licenses; exact versions, origins and archive hashes in portable-inventory.json.\n' +
    '- Node dependencies: node_modules/*/package.json and their included LICENSE/NOTICE files; npm-shrinkwrap.json pins the dependency graph.\n';
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const names = { '--output': 'output', '--asset-root': 'assetRoot', '--build-python': 'buildPython', '--cache-dir': 'cacheDir' };
  const options = {};
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]];
      if (!key || !process.argv[index + 1] || options[key]) throw new Error('Invalid build option: ' + process.argv[index]);
      options[key] = process.argv[index + 1];
    }
    await buildWindowsPortable(options);
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
