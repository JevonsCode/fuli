import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTrayDataDir } from '../src/desktop/windows-controller.js';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../src/native-runtime/windows-assets.js';
import { isMainModule } from '../src/system/main-module.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const contains = (root, path) => !isAbsolute(relative(root, path))
  && relative(root, path).split(/[\\/]/)[0] !== '..';

// The old bundle supplies checksum-verified runtimes and dependencies. Its
// embedded Provider application is replaced with this checkout's Python source.
export async function buildWindowsTray({ assetBundle, output, dataDir, compiler } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64.');
  for (const [name, path] of Object.entries({ assetBundle, output, dataDir })) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Expected an absolute --' + name + ' path.');
  }
  const assets = await realpath(assetBundle);
  output = resolve(output);
  if (existsSync(output)) throw new Error('The tray output directory must not exist.');
  if (contains(PACKAGE_ROOT, output) || contains(output, PACKAGE_ROOT)
      || contains(assets, output) || contains(output, assets)) throw new Error('Output must be separate from the checkout and input assets.');
  dataDir = validateTrayDataDir(output, dataDir);
  if (contains(PACKAGE_ROOT, dataDir) || contains(dataDir, PACKAGE_ROOT)
      || contains(assets, dataDir) || contains(dataDir, assets)) throw new Error('Candidate data must be separate from the checkout and input assets.');
  if (existsSync(dataDir)) throw new Error('Use a new external data directory for the tray candidate.');
  compiler ??= join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!existsSync(compiler)) throw new Error('A .NET Framework C# compiler is required to build the Windows shell.');

  const sourceManifest = await readFile(join(assets, 'portable-files.sha256.json'));
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
  assert.deepEqual(lock, await readFile(join(PACKAGE_ROOT, 'npm-shrinkwrap.json')),
    'Reuse requires the identical lockfile; rebuild the portable assets when dependencies change.');
  const nativeManifest = await verifiedFile('native-bundle.json');
  const assetInventory = JSON.parse(await verifiedFile('portable-inventory.json'));
  const selected = [...index.values()].filter(([name]) => name.startsWith('runtime/') || name.startsWith('node_modules/'));
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
    await writeFile(join(output, 'native-bundle.json'), nativeManifest);
    const providerSource = await refreshEmbeddedProvider(output);
    resolveWindowsNativeBundle(readWindowsNativeBundle(output));
    await writeFile(join(output, 'tray-config.json'), JSON.stringify({
      version: 1, kind: 'windows-tray-candidate', dataDir
    }, null, 2) + '\n');

    const ico = join(scratch, 'fuli.ico');
    const iconSource = join(scratch, 'BuildIcon.cs');
    const iconBuilder = join(scratch, 'BuildIcon.exe');
    await writeFile(iconSource, ICON_BUILDER);
    await run(compiler, ['/nologo', '/target:exe', '/reference:System.Drawing.dll', '/out:' + iconBuilder, iconSource]);
    await run(iconBuilder, [join(PACKAGE_ROOT, 'web', 'assets', 'brand', 'fuli-logo.png'), ico]);
    const manifest = join(scratch, 'tray.manifest');
    await writeFile(manifest, WINDOWS_MANIFEST);
    await run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/codepage:65001',
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll',
      '/win32icon:' + ico, '/win32manifest:' + manifest, '/out:' + join(output, 'Fuli.exe'),
      join(PACKAGE_ROOT, 'desktop', 'windows', 'FuliTray.cs')]);

    const applicationVersion = JSON.parse(await readFile(join(output, 'package.json'), 'utf8')).version;
    await writeFile(join(output, 'TRAY.md'), trayInstructions(applicationVersion, dataDir));
    await writeFile(join(output, 'tray-inventory.json'), JSON.stringify({ version: 1,
      status: 'local-candidate', applicationVersion, shell: '.NET Framework Windows Forms',
      reusedAssets: { prefixes: ['runtime/', 'node_modules/'], files: selected.length,
        sourceChecksumInventorySha256: sha256(sourceManifest), sourceInventory: assetInventory },
      applicationSource: 'current checkout npm pack, management page and embedded Provider source', providerSource,
      iconSource: 'web/assets/brand/fuli-logo.png', buildTime: new Date().toISOString()
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

export async function refreshEmbeddedProvider(output, packageRoot = PACKAGE_ROOT) {
  const site = join(output, 'runtime', 'python', 'Lib', 'site-packages');
  const source = join(packageRoot, 'graph-provider', 'fuli_graph');
  const target = join(site, 'fuli_graph');
  const project = await readFile(join(packageRoot, 'graph-provider', 'pyproject.toml'));
  // The vendored dependencies and dist-info metadata remain reusable only when
  // their package/dependency declaration is exactly the current one.
  assert.deepEqual(await readFile(join(site, 'pyproject.toml')), project,
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
  return `# Fuli ${version} Windows 托盘本地候选 / Local tray candidate\n\n`
    + '双击 Fuli.exe 显示托盘并读取状态；此时不配置、不启动服务。左击托盘或选择“启动并打开”才会配置/启动本候选并打开现有管理页。首次配置跳过所有 Agent 集成。\n\n'
    + `此候选固定数据目录：\n\n${dataDir}\n\n`
    + '程序资产和数据分开；FULI_DATA_DIR 不会替换 tray-config.json 的显式目录。候选拒绝日常默认 Fuli 数据目录，拒绝自动切换已有数据的 runtime mode。相同用户和规范化数据目录只运行一个托盘；再次启动会请求已有托盘打开管理页。\n\n'
    + '关闭浏览器管理页不停止 Fuli。“退出托盘（Fuli 继续运行）”只移除托盘；“停止 Fuli 并退出”先通过本候选 CLI 停止并确认状态，失败则保留托盘、进程状态和数据。状态来自 CLI，包括主动休眠，不把停止状态的退出码 1 当成命令故障。\n\n'
    + '停止后可保留外置数据并删除候选程序目录；不要在运行中搬移程序或数据。Neo4j Community、jlink JRE、Graphiti Provider 和所有生产依赖均随包提供，不需要 Docker、WSL 或系统 Node/Python/Java。托盘外壳使用 Windows .NET Framework；native 进程核验继续使用现有 Windows PowerShell/CIM，无需修改执行策略。\n\n'
    + '这是托盘候选，不是安装器或已发布版本；不注册开机启动、不修改 PATH、不配置日常客户端。尚无安装器升级或自动升级。**不要在本候选使用 `fuli update`，它当前针对全局 npm 安装；管理页现有版本提示也可能仍显示该命令。** 安装方式识别和更新提示将在后续安装切片接入。\n\n'
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

const ICON_BUILDER = `using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.IO;
class BuildIcon {
 static void Main(string[] args) {
  int[] sizes = {16,24,32,48,64,256}; var images = new byte[sizes.Length][];
  using(var original = Image.FromFile(args[0])) {
   for(int i=0;i<sizes.Length;i++) using(var bitmap = new Bitmap(sizes[i],sizes[i])) {
    using(var g = Graphics.FromImage(bitmap)) { g.InterpolationMode=InterpolationMode.HighQualityBicubic; g.DrawImage(original,0,0,sizes[i],sizes[i]); }
    using(var stream = new MemoryStream()) { bitmap.Save(stream,ImageFormat.Png); images[i]=stream.ToArray(); }
   }
  }
  using(var writer = new BinaryWriter(File.Create(args[1]))) {
   writer.Write((short)0); writer.Write((short)1); writer.Write((short)sizes.Length); int offset=6+16*sizes.Length;
   for(int i=0;i<sizes.Length;i++) { writer.Write((byte)(sizes[i]==256?0:sizes[i])); writer.Write((byte)(sizes[i]==256?0:sizes[i])); writer.Write((short)0); writer.Write((short)1); writer.Write((short)32); writer.Write(images[i].Length); writer.Write(offset); offset+=images[i].Length; }
   foreach(var image in images) writer.Write(image);
  }
 }
}`;

if (isMainModule(import.meta.url)) {
  const names = { '--asset-bundle': 'assetBundle', '--output': 'output', '--data-dir': 'dataDir', '--compiler': 'compiler' };
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
