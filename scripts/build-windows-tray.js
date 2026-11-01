import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTrayDataDir } from '../src/desktop/windows-controller.js';
import { WINDOWS_NODE_LAUNCHER } from '../src/desktop/windows-node-launcher.js';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../src/native-runtime/windows-assets.js';
import { isMainModule } from '../src/system/main-module.js';
import { assertShortBuildPath } from './windows-build-path.js';
import { bundleAgentKits } from './agent-kits-bundle.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const contains = (root, path) => !isAbsolute(relative(root, path))
  && relative(root, path).split(/[\\/]/)[0] !== '..';

// The old bundle supplies checksum-verified runtimes and dependencies. Its
// embedded Provider application is replaced with this checkout's Python source.
// A release bumps only the root package's own version; reuse needs identical dependencies.
export function dependencyLock(bytes) {
  const lock = JSON.parse(bytes);
  delete lock.version;
  if (lock.packages?.['']) delete lock.packages[''].version;
  return lock;
}

// The Flutter desktop client's release folder (desktop/flutter, `flutter build windows --release`):
// its executable, engine, plugin DLLs and data folder must stay together, so
// they go to client/ and the root Fuli.exe launcher starts them.
const CLIENT_DIRECTORY = 'client';
const CLIENT_REQUIRED = ['FULI.exe', 'flutter_windows.dll', 'data/icudtl.dat', 'data/app.so', 'data/flutter_assets'];

export async function copyDesktopClient(client, output) {
  if (typeof client !== 'string' || !isAbsolute(client)) throw new Error('Expected an absolute --client path.');
  // Both resolved by the same native realpath, which also expands 8.3 short
  // names (realpathSync keeps them): no spelling of one may hide the overlap.
  const source = await realpath(client);
  const resolvedOutput = await resolvedFuturePath(output);
  if (contains(source, resolvedOutput) || contains(resolvedOutput, source)) throw new Error('The desktop client must be separate from the tray output.');
  for (const name of CLIENT_REQUIRED) {
    if (!existsSync(join(source, name))) throw new Error('The desktop client build is incomplete; missing ' + name + '. Pass the Release folder of flutter build windows.');
  }
  const target = join(output, CLIENT_DIRECTORY);
  await cp(source, target, { recursive: true, dereference: true, errorOnExist: true, force: false });
  return target;
}

// A path that may not exist yet, through the real path of its nearest existing ancestor.
async function resolvedFuturePath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await resolvedFuturePath(dirname(path)), basename(path));
  }
}

export async function buildWindowsTray({ assetBundle, client, output, dataDir, compiler } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64.');
  for (const [name, path] of Object.entries({ assetBundle, client, output, dataDir })) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Expected an absolute --' + name + ' path.');
  }
  output = assertShortBuildPath('--output', output, 'T:\\fb\\tray');
  const assets = await realpath(assetBundle);
  if (existsSync(output)) throw new Error('The tray output directory must not exist.');
  if (contains(PACKAGE_ROOT, output) || contains(output, PACKAGE_ROOT)
      || contains(assets, output) || contains(output, assets)) throw new Error('Output must be separate from the checkout and input assets.');
  dataDir = validateTrayDataDir(output, dataDir);
  if (contains(PACKAGE_ROOT, dataDir) || contains(dataDir, PACKAGE_ROOT)
      || contains(assets, dataDir) || contains(dataDir, assets)) throw new Error('Candidate data must be separate from the checkout and input assets.');
  if (existsSync(dataDir)) throw new Error('Use a new external data directory for the tray candidate.');
  compiler ??= join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!existsSync(compiler)) throw new Error('A .NET Framework C# compiler is required to build the Windows launcher.');

  const sourceManifest = await readFile(join(assets, existsSync(join(assets, 'portable-files.sha256.json'))
    ? 'portable-files.sha256.json' : 'tray-files.sha256.json'));
  const entries = JSON.parse(sourceManifest);
  if (!Array.isArray(entries)) throw new Error('The portable checksum inventory is invalid.');
  const index = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry[1]) || isAbsolute(entry[0])
        || entry[0].split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
      throw new Error('An invalid path or checksum was found in the portable inventory.');
    }
    const key = entry[0].replaceAll('\\', '/');
    if (index.has(key.toLowerCase())) throw new Error('Duplicate portable inventory path: ' + key);
    index.set(key.toLowerCase(), [key, entry[1]]);
  }
  async function verifiedFile(name) {
    const entry = index.get(name.toLowerCase());
    if (!entry) throw new Error('Missing portable checksum: ' + name);
    const path = await realpath(join(assets, entry[0]));
    if (!contains(assets, path)) throw new Error('Portable asset escaped its directory: ' + name);
    const bytes = await readFile(path);
    assert.equal(sha256(bytes), entry[1], 'Portable asset checksum mismatch: ' + name);
    return bytes;
  }
  const lock = await verifiedFile('npm-shrinkwrap.json');
  assert.deepEqual(dependencyLock(lock), dependencyLock(await readFile(join(PACKAGE_ROOT, 'npm-shrinkwrap.json'))),
    'Reuse requires the identical lockfile; rebuild the portable assets when dependencies change.');
  const nativeManifest = await verifiedFile('native-bundle.json');
  const assetInventory = index.has('portable-inventory.json')
    ? JSON.parse(await verifiedFile('portable-inventory.json'))
    : JSON.parse(await verifiedFile('tray-inventory.json')).reusedAssets.sourceInventory;
  // The shared client components come from this checkout's pins, not from the reused bundle.
  const selected = [...index.values()].filter(([name]) => (name.startsWith('runtime/') && !name.startsWith('runtime/agent-kits/'))
    || name.startsWith('node_modules/'));
  if (!selected.some(([name]) => name.startsWith('runtime/'))
      || !selected.some(([name]) => name.startsWith('node_modules/'))) throw new Error('The complete portable runtime and production dependencies are required.');
  const scratch = await mkdtemp(join(tmpdir(), 'fuli-tray-build-'));
  try {
    const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const env = { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' };
    process.stdout.write('Building the current application and management page...\n');
    await run(process.execPath, [npm, 'run', 'build'], { cwd: PACKAGE_ROOT, env });
    const packed = JSON.parse(await run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json',
      '--pack-destination', scratch], { cwd: PACKAGE_ROOT, env }))[0];
    await run(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xzf', join(scratch, packed.filename), '-C', scratch]);
    await cp(join(scratch, 'package'), output, { recursive: true, dereference: true });
    process.stdout.write('Copying verified runtime and production dependencies; excluding all input data...\n');
    for (let offset = 0; offset < selected.length; offset += 16) {
      await Promise.all(selected.slice(offset, offset + 16).map(async ([name]) => {
        const bytes = await verifiedFile(name);
        const target = join(output, name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }));
    }
    const kits = await bundleAgentKits({ output, cacheDir: scratch });
    await writeFile(join(output, 'native-bundle.json'),
      JSON.stringify({ ...JSON.parse(nativeManifest), agentKits: kits.agentKits }, null, 2) + '\n');
    const providerSource = await refreshEmbeddedProvider(output);
    resolveWindowsNativeBundle(readWindowsNativeBundle(output));
    await writeFile(join(output, 'tray-config.json'), JSON.stringify({
      version: 1, kind: 'windows-tray-candidate', dataDir
    }, null, 2) + '\n');

    process.stdout.write('Adding the desktop client and its launcher...\n');
    await copyDesktopClient(client, output);
    const manifest = join(scratch, 'launcher.manifest');
    await writeFile(manifest, WINDOWS_MANIFEST);
    await run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/codepage:65001', '/reference:System.Windows.Forms.dll',
      '/win32icon:' + join(PACKAGE_ROOT, APP_ICON), '/win32manifest:' + manifest, '/out:' + join(output, 'Fuli.exe'),
      join(PACKAGE_ROOT, 'desktop', 'windows', 'FuliLauncher.cs')]);
    await compileWindowsNodeLauncher(compiler, output, scratch);

    const applicationVersion = JSON.parse(await readFile(join(output, 'package.json'), 'utf8')).version;
    for (const [name, command] of [['Install-Fuli.cmd', 'windows-install.js'], ['Update-Fuli.cmd', 'windows-update-command.js'],
      ['Rollback-Fuli.cmd', 'windows-rollback-command.js'], ['Uninstall-Fuli.cmd', 'windows-uninstall-command.js']]) {
      await writeFile(join(output, name), '@echo off\r\n"%~dp0runtime\\node\\node.exe" "%~dp0src\\desktop\\' + command + '" %*\r\nif errorlevel 1 pause\r\n');
    }
    await writeFile(join(output, 'TRAY.md'), trayInstructions(applicationVersion, dataDir));
    await writeFile(join(output, 'tray-inventory.json'), JSON.stringify({ version: 1,
      status: 'local-candidate', applicationVersion,
      shell: 'Flutter desktop client (' + CLIENT_DIRECTORY + '/) started by a .NET Framework launcher (Fuli.exe)',
      reusedAssets: { prefixes: ['runtime/', 'node_modules/'], files: selected.length,
        sourceChecksumInventorySha256: sha256(sourceManifest), sourceInventory: assetInventory },
      applicationSource: 'current checkout npm pack, management page and embedded Provider source', providerSource,
      agentKits: kits.inventory,
      iconSource: APP_ICON, buildTime: new Date().toISOString()
    }, null, 2) + '\n');
    const files = await hashTree(output);
    await writeFile(join(output, 'tray-files.sha256.json'), JSON.stringify(files, null, 2) + '\n');
    assert.equal(existsSync(dataDir), false, 'Building the tray must not create or configure its data directory.');
    process.stdout.write('Tray candidate built: ' + output + '\nExternal data (not created): ' + dataDir + '\n');
    return { output, dataDir, files: files.length };
  } finally {
    assert.equal(dirname(scratch), resolve(tmpdir()));
    await rm(scratch, { recursive: true, force: true });
  }
}

// FuliNode.exe, the stable command of an installed FULI's client configurations
// (rec#11 D-80): a console program, so it shares its caller's console and stdio.
export async function compileWindowsNodeLauncher(compiler, output, scratch) {
  const manifest = join(scratch, 'node-launcher.manifest');
  await writeFile(manifest, WINDOWS_MANIFEST);
  await run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/codepage:65001', '/reference:System.Web.Extensions.dll',
    '/win32icon:' + join(PACKAGE_ROOT, APP_ICON), '/win32manifest:' + manifest, '/out:' + join(output, WINDOWS_NODE_LAUNCHER),
    join(PACKAGE_ROOT, 'desktop', 'windows', 'FuliNodeLauncher.cs')]);
}

// Copied from brand/png/app-icon/fuli-app.ico by scripts/build-brand-assets.js.
const APP_ICON = 'desktop/flutter/windows/runner/resources/app_icon.ico';

const PROJECT_VERSION = /^version\s*=\s*"([^"]+)"\s*$/m;
const withoutProjectVersion = bytes => bytes.toString('utf8').replace(PROJECT_VERSION, '');

async function stampProviderVersion(site, project) {
  const version = PROJECT_VERSION.exec(project.toString('utf8'))?.[1];
  if (!version) throw new Error('The current Provider pyproject has no project version.');
  await writeFile(join(site, 'pyproject.toml'), project);
  for (const entry of await readdir(site)) {
    if (!/^fuli_graph_provider-.+\.dist-info$/i.test(entry)) continue;
    const metadata = join(site, entry, 'METADATA');
    if (!existsSync(metadata)) continue;
    await writeFile(metadata, (await readFile(metadata, 'utf8')).replace(/^Version: .*$/m, 'Version: ' + version));
  }
}

export async function refreshEmbeddedProvider(output, packageRoot = PACKAGE_ROOT) {
  const site = join(output, 'runtime', 'python', 'Lib', 'site-packages');
  const source = join(packageRoot, 'graph-provider', 'fuli_graph');
  const target = join(site, 'fuli_graph');
  const project = await readFile(join(packageRoot, 'graph-provider', 'pyproject.toml'));
  // The vendored dependencies stay reusable only when their declaration is the
  // current one; a release changes only the Provider's own version, which is
  // stamped into its metadata below so health reports the real version.
  const embedded = await readFile(join(site, 'pyproject.toml'));
  assert.equal(withoutProjectVersion(embedded), withoutProjectVersion(project),
    'Provider pyproject changed; rebuild portable Python dependencies before building the tray.');
  const sources = [];
  async function collect(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory() && entry.name !== '__pycache__') await collect(join(directory, entry.name), name);
      else if (entry.isFile() && entry.name.endsWith('.py')) sources.push([name, await readFile(join(directory, entry.name))]);
    }
  }
  await collect(source);
  if (!sources.some(([name]) => name === 'app.py')) throw new Error('The current Provider application source is incomplete.');
  assert.ok(isAbsolute(output) && contains(output, target) && target !== output,
    'Provider source replacement must stay inside the candidate output.');
  await rm(target, { recursive: true, force: true });
  for (const [name, bytes] of sources) {
    await mkdir(dirname(join(target, name)), { recursive: true });
    await writeFile(join(target, name), bytes);
  }
  if (!embedded.equals(project)) await stampProviderVersion(site, project);
  return { files: sources.length, pyprojectSha256: sha256(project),
    sha256Tree: sha256(JSON.stringify(sources.map(([name, bytes]) => [name, sha256(bytes)]))) };
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

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => execFile(command, args, {
    windowsHide: true, timeout: 20 * 60_000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options
  }, (error, stdout, stderr) => error
    ? reject(new Error('Tray build failed (' + error.code + '): ' + (stderr || stdout).slice(-4000)))
    : resolveRun(stdout)));
}

function trayInstructions(version, dataDir) {
  return `# Fuli ${version} Windows 本地候选 / Local Windows candidate\n\n`
    + '双击 Fuli.exe 打开 FULI 桌面客户端（窗口和托盘图标，程序在 client\\ 目录）并读取状态；此时不配置、不启动服务。点「启动 FULI」才会配置/启动本候选；「打开控制台」打开现有管理页。首次配置跳过所有 Agent 集成。托盘图标的圆点：绿色正常，琥珀色需要你处理，红色不能正常使用。\n\n'
    + `此候选固定数据目录：\n\n${dataDir}\n\n`
    + '程序资产和数据分开；FULI_DATA_DIR 不会替换 tray-config.json 的显式目录。候选拒绝日常默认 Fuli 数据目录，拒绝自动切换已有数据的 runtime mode。相同用户和规范化数据目录只运行一个客户端；再次打开会显示已有客户端的窗口。\n\n'
    + '关闭客户端窗口或浏览器管理页都不停止 Fuli；窗口收进托盘。托盘菜单「退出」只关闭客户端（Fuli 继续运行）；「停止 FULI」通过本候选 CLI 停止并确认状态。状态来自 CLI，包括主动休眠，不把停止状态的退出码 1 当成命令故障。\n\n'
    + '托盘菜单「换一个端口」把管理页改到默认端口附近一个未被 Windows 保留、也未被占用的端口（落在保留段内的其他 Fuli 端口一并移出），先备份原 runtime-settings.json，再重启 Fuli；因保留端口启动失败时，启动失败的提示会建议它。已打开的 Agent 会话重开后，Fuli 链接才指向新地址。安装后的客户端默认开机启动（只显示托盘图标），可在托盘菜单「开机时启动」关闭。\n\n'
    + '更新要求客户端退出时，正在进行的启动、停止或换端口先做完（每个 CLI 操作最多约五分钟），不会让新旧客户端交错操作。\n\n'
    + '停止后可保留外置数据并删除候选程序目录；不要在运行中搬移程序或数据。Neo4j Community、jlink JRE、Graphiti Provider 和所有生产依赖均随包提供，不需要 Docker、WSL 或系统 Node/Python/Java。桌面客户端是 Flutter 程序，根目录的 Fuli.exe 是启动它的 .NET Framework 小程序；native 进程核验继续使用现有 Windows PowerShell/CIM，无需修改执行策略。\n\n'
    + '双击 Install-Fuli.cmd 可确认首次单用户安装：默认程序目录 %LOCALAPPDATA%\\Programs\\Fuli、数据目录 %LOCALAPPDATA%\\Fuli，并创建桌面和开始菜单快捷方式；无需管理员，不启动服务、不修改 PATH 或 Agent 客户端；首次打开安装后的桌面客户端时开启开机启动，可在托盘菜单关闭。默认拒绝已有程序目录、数据目录或同名快捷方式，不自动迁移 container 数据。安装记录与包位置共同识别 installed 上下文。安装时可用 --adopt-existing-data 显式接入已有数据；container 到 native 的迁移仍需另行确认。升级要求已从桌面客户端配置 native 模式；新包的 Neo4j 可以是同一版本线的更新补丁（切换前先备份图谱，之后不能回退到旧补丁），降版本或跨版本线会被拒绝；从新版候选双击 Update-Fuli.cmd（它会先关闭正在运行的桌面客户端，完成后重新打开）：校验包、保留数据与旧版本，切换失败时确认新版停止后回退程序；--preview 仅预览，--install-root 指定自定义安装位置；从版本号更高的本机 rc 版换成 beta 版时，先备份数据目录，再加 --allow-downgrade 明确同意。不回退数据库 schema，不跨版本数据库迁移。已安装版本目录中的 Rollback-Fuli.cmd 回到更新前保留的旧版本（只切换程序，不回退数据）；Uninstall-Fuli.cmd 关闭桌面客户端、停止服务、断开 Agent 客户端并删除快捷方式、开机启动项、「已安装的应用」中的 FULI 项与全部版本，保留数据目录；两者都支持 --preview 与 --install-root；已安装副本拒绝 npm 的 `fuli update`。安装后也可以在管理页点「更新到 vX」：自动下载并校验 GitHub 发布的托盘包，关闭桌面客户端，运行同一个 Update-Fuli，再重新打开客户端；被其他 FULI 程序挡住时页面会列出它的进程号和程序位置。源候选仍固定使用上面的隔离数据目录。\n\n'
    + '已安装副本的 Agent 客户端配置（MCP、hook、OpenCode 插件）写的是安装目录根部的 FuliNode.exe 和包内相对脚本：它每次启动时读取 installation.json，运行当前版本自带的 node，所以更新和回退不需要改写客户端配置。安装、更新和回退会放置或刷新它，卸载会删除它。\n\n'
    + 'tray-inventory.json 记录复用资产的范围及来源清单；只从输入候选的 runtime/、node_modules/ 逐文件校验后复制，没有复制其 data/、日志、认证或客户端配置。内嵌 Provider 的 pyproject 必须与当前工作树相同，其 fuli_graph 源码整树替换为当前工作树版本，避免复用旧应用代码。应用和管理页也来自当前工作树。tray-files.sha256.json 覆盖完整新候选，外置运行数据不在其中。\n\n'
    + '非 UI 验证：使用本候选的 runtime/node/node.exe 运行 src/desktop/windows-controller.js status|start|stop。控制器没有任意 shell 参数入口；open/start-open 会打开系统浏览器，应留给人工 UI 验收。\n';
}

const WINDOWS_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
 <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>
  <requestedExecutionLevel level="asInvoker" uiAccess="false" />
 </requestedPrivileges></security></trustInfo>
 <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>
  <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>
 </windowsSettings></application>
</assembly>`;

if (isMainModule(import.meta.url)) {
  const names = { '--asset-bundle': 'assetBundle', '--client': 'client', '--output': 'output', '--data-dir': 'dataDir', '--compiler': 'compiler' };
  const options = {};
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]];
      if (!key || !process.argv[index + 1] || options[key]) throw new Error('Invalid tray build option: ' + process.argv[index]);
      options[key] = process.argv[index + 1];
    }
    await buildWindowsTray(options);
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
