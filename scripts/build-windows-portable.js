import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../src/system/main-module.js';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../src/native-runtime/windows-assets.js';
import { assertShortBuildPath } from './windows-build-path.js';
import { bundleAgentKits } from './agent-kits-bundle.js';

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
  output = assertShortBuildPath('--output', output, 'T:\\fb\\portable');
  cacheDir = assertShortBuildPath('--cache-dir', cacheDir, 'T:\\fb\\portable');
  assetRoot = resolve(assetRoot);
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
    progress('Bundling the pinned session launcher and client installer');
    const kits = await bundleAgentKits({ output, cacheDir });

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
      providerSource: 'runtime/python/Lib/site-packages', dataDir: 'data', agentKits: kits.agentKits };
    await writeFile(join(output, 'native-bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
    const resolvedBundle = resolveWindowsNativeBundle(readWindowsNativeBundle(output));
    await writeFile(join(output, 'fuli.cmd'), '@echo off\r\n"%~dp0runtime\\node\\node.exe" "%~dp0src\\cli.js" %*\r\n');
    await writeFile(join(output, 'fl.cmd'), '@echo off\r\n"%~dp0runtime\\node\\node.exe" "%~dp0src\\cli.js" %*\r\n');
    for (const [name, action] of [['启动并打开 Fuli.cmd', 'start'], ['停止 Fuli.cmd', 'stop'], ['仅打开 Fuli.cmd', 'open']]) {
      await writeFile(join(output, name), portableLauncher(action), 'utf8');
    }
    const inventory = { version: 1, applicationVersion: JSON.parse(await readFile(join(output, 'package.json'), 'utf8')).version,
      status: 'local-candidate', downloads: DOWNLOADS, agentKits: kits.inventory, pythonPackages,
      versions: { node: '24.18.0', python: '3.12.10', neo4j: resolvedBundle.neo4jVersion, java: resolvedBundle.javaVersion },
      suppliedAssets: ['neo4j', 'jre21'].map((name, index) => ({ name,
        source: 'provided read-only .tools/' + name, fileCount: assetBefore[index].length,
        sha256Tree: sha256(JSON.stringify(assetBefore[index])), licenses: name === 'neo4j'
          ? ['runtime/neo4j/LICENSE.txt', 'runtime/neo4j/LICENSES.txt', 'runtime/neo4j/NOTICE.txt', 'runtime/neo4j/licenses']
          : ['runtime/jre21/legal', 'runtime/jre21/release'] })) };
    await writeFile(join(output, 'portable-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
    await writeFile(join(output, 'PORTABLE.md'), portableInstructions(inventory.applicationVersion));
    await writeFile(join(output, 'THIRD_PARTY_NOTICES.md'), thirdPartyNotices(resolvedBundle.neo4jVersion));
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

function portableLauncher(action) {
  const cli = '"%FULI_PORTABLE_ROOT%runtime\\node\\node.exe" "%FULI_PORTABLE_ROOT%src\\cli.js"';
  const data = '--data-dir "%FULI_PORTABLE_ROOT%data"';
  const commands = {
    start: [
      'echo 正在启动并打开 Fuli / Starting and opening Fuli...',
      'if exist "%FULI_PORTABLE_ROOT%data\\graph-runtime.json" goto start',
      'echo 首次配置本目录 / Configuring this directory for the first time...',
      `${cli} setup --yes --skip-agents --personal-only --runtime-mode native ${data}`,
      'if errorlevel 1 goto failed',
      `${cli} open ${data}`,
      'if errorlevel 1 goto failed',
      'goto succeeded',
      ':start',
      `${cli} start --open ${data}`,
      'if errorlevel 1 goto failed'
    ],
    stop: [
      'echo 正在停止本目录 Fuli / Stopping Fuli in this directory...',
      `${cli} stop ${data}`,
      'if errorlevel 1 goto failed',
      'echo 检查停止状态 / Checking stopped status...',
      // status exits 1 for both stopped and not_configured. Parse its existing
      // JSON contract rather than treating that normal exit as a stop failure.
      '"%FULI_PORTABLE_ROOT%runtime\\node\\node.exe" -e "const{spawnSync}=require(\'node:child_process\');const r=spawnSync(process.execPath,[process.argv[1],\'status\',\'--json\',\'--data-dir\',process.argv[2]],{encoding:\'utf8\',windowsHide:true});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);if(r.error){console.error(r.error.message);process.exit(1)}try{process.exit([0,1].includes(r.status)&&[\'stopped\',\'not_configured\'].includes(JSON.parse(r.stdout).status)?0:1)}catch{process.exit(1)}" "%FULI_PORTABLE_ROOT%src\\cli.js" "%FULI_PORTABLE_ROOT%data"',
      'if errorlevel 1 goto failed'
    ],
    open: [
      'echo 仅打开已运行的 Fuli / Opening the running Fuli console only...',
      `${cli} open ${data}`,
      'if errorlevel 1 goto failed'
    ]
  };
  return ['@echo off', 'setlocal DisableDelayedExpansion', '"%SystemRoot%\\System32\\chcp.com" 65001 >nul',
    'set "FULI_PORTABLE_ROOT=%~dp0"', ...commands[action], ':succeeded',
    'echo 操作完成 / Done.', 'exit /b 0', ':failed', 'set "FULI_PORTABLE_EXIT=%errorlevel%"',
    'echo.', 'echo 操作失败，原始错误见上 / Operation failed; original error appears above.',
    'echo 日志目录 / Logs: "%FULI_PORTABLE_ROOT%data\\logs"',
    'echo Native 日志 / Native logs: "%FULI_PORTABLE_ROOT%data\\native-runtime\\personal\\logs"',
    'echo 按任意键关闭 / Press any key to close.', 'pause >nul', 'exit /b %FULI_PORTABLE_EXIT%', ''
  ].join('\r\n');
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
    '双击本目录入口：\n\n' +
    '- **启动并打开 Fuli.cmd**：首次自动配置本目录的个人 native 服务（跳过 Agent 集成），成功后打开管理页面；之后启动并打开。\n' +
    '- **停止 Fuli.cmd**：停止本目录服务并显示 JSON 状态；已停止或尚未配置也正常结束。\n' +
    '- **仅打开 Fuli.cmd**：只打开已运行服务的管理页面，不自动启动或配置。\n\n' +
    '这三个入口固定使用本目录 runtime/node/node.exe、src/cli.js 与 data/，覆盖 FULI_DATA_DIR；错误保留在窗口中并显示日志目录，按键后关闭。不会选择 PATH 中的 Fuli 或修改日常 Agent 集成。fuli.cmd / fl.cmd 保留原有完整 CLI 参数行为。\n\n' +
    '在此目录运行：\n\n```powershell\n.\\fuli.cmd setup --yes --skip-agents --personal-only --runtime-mode native\n.\\fuli.cmd status --json\n.\\fuli.cmd stop\n.\\fuli.cmd start\n```\n\n' +
    'native-bundle.json 的路径全部相对于包目录；默认数据保存在 data/。显式 --data-dir 优先于 FULI_DATA_DIR，再优先于包内 data/。普通 npm 安装继续使用原平台数据目录。\n\n' +
    '搬移前先 stop，确认 status 已停止并且所有 owned 进程退出，再整体搬移目录。src/、runtime/ 等程序资产与 data/ 一起搬移；也可通过 CLI --data-dir 指定独立数据目录并单独保留它。首次启动会重解析当前包路径。不要在运行中搬移或复制图数据。\n\n' +
    '移除候选时默认保留数据：先 stop；备份并保留 data/ 或外部数据目录，再删除程序资产与 launcher。本候选只验收此手动移除策略，未验收系统卸载程序；不要通过 uninstall 命令影响日常客户端集成。验收 setup 使用 --skip-agents，不改全局客户端配置。\n\n' +
    'portable-inventory.json 记录固定下载来源、SHA256、Provider 依赖版本和资产许可证；portable-files.sha256.json 是构建时文件树，不含运行后的 data/。\n';
}

// neo4jVersion: the version the supplied runtime/neo4j actually contains.
function thirdPartyNotices(neo4jVersion) {
  return '# Included third-party components\n\n' +
    '- Fuli: LICENSE and package.json.\n' +
    '- Node.js 24.18.0: runtime/node/LICENSE, official Node.js binary archive.\n' +
    '- CPython 3.12.10 embeddable: runtime/python/LICENSE.txt; official Python.org archive.\n' +
    `- Neo4j Community ${neo4jVersion}: runtime/neo4j/LICENSE.txt, LICENSES.txt, NOTICE.txt and licenses/.\n` +
    '- Provided Eclipse Temurin Java 21 jlink image: runtime/jre21/release and legal/ (included image provenance, not a newly downloaded JDK).\n' +
    '- agent-session-launcher and agent-installer (MIT): runtime/agent-kits/*.exe, pinned release downloads listed in portable-inventory.json; licenses in src/agent-kits/vendor/*/LICENSE.\n' +
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
