import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { resolveNativeJavaHome } from '../src/native-runtime/java-runtime.js';
import { readMacosNativeBundle } from '../src/native-runtime/macos-assets.js';
import { NATIVE_NEO4J_SHA256, NATIVE_NEO4J_URL, NATIVE_NEO4J_VERSION } from '../src/native-runtime/runtime.js';
import { isMainModule } from '../src/system/main-module.js';
import {
  PACKAGE_ROOT, buildEnvironment, buildProviderWheel, finishProviderSite, packCurrentApplication, pinnedArchive,
  progress, run
} from './bundle-build.js';
import { signMacosApp } from './sign-macos-app.js';

// FULI.app for Apple silicon: the Flutter desktop client (`flutter build macos`)
// with FULI and everything it runs inside Contents/Resources/fuli, so a Mac
// without Node, Java or Python runs it (docs/macos-app.md):
//   runtime/node/bin/node          Node.js, the only Node file shipped
//   runtime/jre21                  a jlink image of the build's JDK 21
//   runtime/neo4j-community-*.tar.gz  the pinned Neo4j archive, unpacked into
//                                  the data directory on first setup
//   runtime/python                 a relocatable CPython with the Provider and
//                                  its dependencies installed into it
// The app is signed ad hoc here (scripts/sign-macos-app.js); a Developer ID
// signature replaces it later when one is available.

const NODE_VERSION = '24.18.0';
const PYTHON_VERSION = '3.12.15';
const PYTHON_BUILD = '20261013';
const PYTHON_SITE = 'lib/python3.12/site-packages';
// Node 24's macOS minimum; the client alone would run on older systems.
const MINIMUM_MACOS = '13.5';
const ARCH = 'arm64';
const DOWNLOADS = {
  node: { filename: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1',
    checksumSource: `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt` },
  python: { filename: `cpython-${PYTHON_VERSION}+${PYTHON_BUILD}-aarch64-apple-darwin-install_only.tar.gz`,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD}/cpython-${PYTHON_VERSION}%2B${PYTHON_BUILD}-aarch64-apple-darwin-install_only.tar.gz`,
    sha256: 'ba32036ad8f4c434d97a1ee7feef8b7edc0fac16777639b97e39c74a108e4440',
    checksumSource: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD}/SHA256SUMS` },
  neo4j: { filename: `neo4j-community-${NATIVE_NEO4J_VERSION}-unix.tar.gz`, url: NATIVE_NEO4J_URL,
    sha256: NATIVE_NEO4J_SHA256, checksumSource: 'src/native-runtime/runtime.js (NATIVE_NEO4J_SHA256)' }
};
const TAR = '/usr/bin/tar';

export async function buildMacosApp({ client, output, jdk, cacheDir } = {}) {
  if (process.platform !== 'darwin' || process.arch !== ARCH) throw new Error('Build on macOS arm64 (Apple silicon).');
  for (const [name, path] of Object.entries({ client, output, jdk, cacheDir })) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Expected an absolute --' + name + ' path.');
  }
  if (!existsSync(join(client, 'Contents', 'MacOS', 'FULI'))) {
    throw new Error('Pass the FULI.app that `flutter build macos --release` produced as --client.');
  }
  if (existsSync(output)) throw new Error('The output directory must not exist.');
  const inside = (root, path) => { const local = relative(root, path); return !isAbsolute(local) && !local.startsWith('..'); };
  if ([output, cacheDir].some(path => inside(PACKAGE_ROOT, path))) throw new Error('Output must be outside the source checkout.');

  const env = buildEnvironment('/dev/null');
  await mkdir(output, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  const scratch = await mkdtemp(join(cacheDir, 'build-'));
  const app = join(output, 'FULI.app');
  try {
    // ditto keeps the frameworks' symbolic links that a plain copy would follow.
    await run('/usr/bin/ditto', [client, app]);
    await fitClientToRuntime(app);
    const root = join(app, 'Contents', 'Resources', 'fuli');
    await packCurrentApplication({ output: root, scratch, env, tar: TAR });
    const archives = {};
    for (const [key, artifact] of Object.entries(DOWNLOADS)) archives[key] = await pinnedArchive(artifact, cacheDir, key);
    const runtime = join(root, 'runtime');

    progress('Adding Node.js ' + NODE_VERSION);
    await run(TAR, ['-xzf', archives.node, '-C', scratch]);
    const nodeRelease = join(scratch, `node-v${NODE_VERSION}-darwin-arm64`);
    await mkdir(join(runtime, 'node', 'bin'), { recursive: true });
    // npm and its friends are build tools; the app never installs packages.
    await cp(join(nodeRelease, 'bin', 'node'), join(runtime, 'node', 'bin', 'node'));
    await cp(join(nodeRelease, 'LICENSE'), join(runtime, 'node', 'LICENSE'));

    progress('Adding a jlink Java 21 runtime');
    await run(join(jdk, 'bin', 'jlink'), ['--module-path', join(jdk, 'jmods'), '--add-modules', 'ALL-MODULE-PATH',
      '--strip-debug', '--no-man-pages', '--no-header-files', '--output', join(runtime, 'jre21')], { capture: true });

    progress('Adding the pinned Neo4j ' + NATIVE_NEO4J_VERSION + ' archive');
    await cp(archives.neo4j, join(runtime, DOWNLOADS.neo4j.filename));

    progress('Adding Python ' + PYTHON_VERSION + ' with the Provider and its dependencies');
    await run(TAR, ['-xzf', archives.python, '-C', runtime]);
    const python = join(runtime, 'python', 'bin', 'python3');
    const wheel = await buildProviderWheel(python, join(scratch, 'wheels'), env);
    const reportPath = join(scratch, 'python-install.json');
    // This interpreter is the app's own; nothing else manages its packages.
    await run(python, ['-I', '-m', 'pip', 'install', '--quiet', '--only-binary=:all:', '--no-compile',
      '--break-system-packages', '--report', reportPath, wheel], { env });
    const site = join(runtime, 'python', PYTHON_SITE);
    const pythonPackages = await finishProviderSite(site, reportPath, wheel);
    // pip's console scripts name this build's path; FULI runs `python3 -m uvicorn`.
    await keepOnlyInterpreters(join(runtime, 'python', 'bin'));

    const manifest = { version: 1, platform: 'darwin', arch: ARCH, providerPackaging: 'embedded',
      javaHome: 'runtime/jre21', neo4jArchive: 'runtime/' + DOWNLOADS.neo4j.filename,
      providerPython: 'runtime/python/bin/python3', providerSource: 'runtime/python/' + PYTHON_SITE };
    await writeFile(join(root, 'native-bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
    const versions = await verifyBundle(root, site, env);
    const applicationVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
    await writeFile(join(root, 'app-inventory.json'), JSON.stringify({ version: 1, applicationVersion, arch: ARCH,
      status: 'unsigned-candidate', downloads: DOWNLOADS, pythonPackages,
      versions: { node: NODE_VERSION, python: PYTHON_VERSION, neo4j: NATIVE_NEO4J_VERSION, java: versions.java },
      buildTime: new Date().toISOString() }, null, 2) + '\n');
    await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), thirdPartyNotices(versions.java));

    await signMacosApp({ app });
    progress('FULI.app built: ' + app);
    return { app, applicationVersion };
  } finally {
    assert.equal(dirname(scratch), cacheDir);
    await rm(scratch, { recursive: true, force: true });
  }
}

// The runtime is arm64 and needs Node 24's macOS: the client says so to macOS,
// which then refuses an Intel Mac or an older system with its own message.
async function fitClientToRuntime(app) {
  const executable = join(app, 'Contents', 'MacOS', 'FULI');
  const archs = (await run('/usr/bin/lipo', ['-archs', executable], { capture: true })).trim().split(/\s+/);
  if (!archs.includes(ARCH)) throw new Error('The desktop client has no ' + ARCH + ' code.');
  if (archs.length > 1) await run('/usr/bin/lipo', [executable, '-thin', ARCH, '-output', executable]);
  await run('/usr/bin/plutil', ['-replace', 'LSMinimumSystemVersion', '-string', MINIMUM_MACOS,
    join(app, 'Contents', 'Info.plist')]);
}

async function keepOnlyInterpreters(bin) {
  for (const name of await readdir(bin)) {
    if (!/^python3(\.12)?$/.test(name)) await rm(join(bin, name), { recursive: true, force: true });
  }
}

// What the app will run, run once from where it will run it.
async function verifyBundle(root, site, env) {
  const bundle = readMacosNativeBundle(root);
  const node = join(root, 'runtime', 'node', 'bin', 'node');
  assert.equal((await run(node, [join(root, 'src', 'cli.js'), '--version'], { capture: true })).trim(),
    JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, 'The bundled CLI must run on the bundled Node.');
  const javaHome = await resolveNativeJavaHome({ FULI_NATIVE_JAVA_HOME: bundle.javaHome });
  const java = /^JAVA_VERSION="([^"]+)"/m.exec(await readFile(join(javaHome, 'release'), 'utf8'))?.[1];
  assert.match(java ?? '', /^21(\.|$)/, 'The bundled Java must be Java 21.');
  const probe = JSON.parse(await run(bundle.providerPython, ['-I', '-B', '-c',
    'import json,sys,fuli_graph,graphiti_core,neo4j,uvicorn; print(json.dumps({"prefix":sys.prefix,"isolated":sys.flags.isolated,"provider":fuli_graph.__file__}))'],
  { capture: true, env }));
  assert.equal(await realpath(probe.prefix), await realpath(join(root, 'runtime', 'python')));
  assert.equal(probe.isolated, 1);
  assert.ok((await realpath(probe.provider)).startsWith(await realpath(site) + '/'), 'The Provider must load from the bundled site-packages.');
  assert.ok(existsSync(bundle.neo4jArchive));
  return { java };
}

function thirdPartyNotices(javaVersion) {
  return '# Included third-party components\n\n'
    + '- Fuli: LICENSE and package.json.\n'
    + `- Node.js ${NODE_VERSION}: runtime/node/LICENSE; official Node.js binary archive.\n`
    + `- CPython ${PYTHON_VERSION} (python-build-standalone ${PYTHON_BUILD}): runtime/python/lib/python3.12/LICENSE.txt and the build's licenses.\n`
    + `- Neo4j Community ${NATIVE_NEO4J_VERSION}: the archive in runtime/ carries LICENSE.txt, LICENSES.txt, NOTICE.txt and licenses/.\n`
    + `- Java ${javaVersion}: a jlink image of the build's Eclipse Temurin JDK; runtime/jre21/legal and release.\n`
    + '- Python/Graphiti dependencies: *.dist-info metadata and licenses under runtime/python/lib/python3.12/site-packages; versions, origins and hashes in app-inventory.json.\n'
    + '- Node dependencies: node_modules/*/package.json and their LICENSE/NOTICE files; npm-shrinkwrap.json pins the dependency graph.\n';
}

if (isMainModule(import.meta.url)) {
  const names = { '--client': 'client', '--output': 'output', '--jdk': 'jdk', '--cache-dir': 'cacheDir' };
  const options = {};
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]];
      if (!key || !process.argv[index + 1] || options[key]) throw new Error('Invalid build option: ' + process.argv[index]);
      options[key] = process.argv[index + 1];
    }
    await buildMacosApp(options);
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
