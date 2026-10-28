import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { installWindowsForCurrentUser } from '../../src/desktop/windows-installation.js';
import { installationSha256 } from '../../src/desktop/windows-installation-context.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function windowsInstallationFixture(t) {
  // The installer canonicalizes its paths, so derive expectations from the same real path
  // (macOS tmpdir() is /var/..., which resolves to /private/var/...).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fuli-first-install-')));
  t.after(() => { assert.equal(dirname(root), realpathSync(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const source = join(root, 'candidate');
  const files = {
    'package.json': JSON.stringify({ name: 'fuli-context', version: '0.12.4' }),
    'tray-config.json': JSON.stringify({ version: 1, kind: 'windows-tray-candidate', dataDir: join(root, 'candidate-data') }),
    'native-bundle.json': JSON.stringify({ version: 1, platform: 'win32', arch: 'x64', providerPackaging: 'embedded',
      neo4jHome: 'runtime/neo4j', javaHome: 'runtime/java', providerPython: 'runtime/python/python.exe',
      providerSource: 'runtime/python/Lib/site-packages', dataDir: 'data' }),
    'runtime/java/release': 'JAVA_VERSION="21.0.10"', 'runtime/java/bin/java.exe': '', 'runtime/java/lib/modules': '',
    'runtime/neo4j/conf/neo4j.conf': '', 'runtime/neo4j/lib/neo4j-kernel-5.26.28.jar': '', 'runtime/neo4j/lib/neo4j-5.26.28.jar': '',
    'runtime/python/python.exe': '', 'runtime/python/python312.zip': '',
    'runtime/python/python312._pth': 'python312.zip\n.\nLib/site-packages\nimport site\n',
    'runtime/python/Lib/site-packages/fuli_graph/app.py': '', 'runtime/node/node.exe': '',
    'node_modules/example/index.js': '', 'src/cli.js': '', 'src/desktop/windows-controller.js': '', 'Fuli.exe': '', 'client/FULI.exe': ''
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(source, name)), { recursive: true }); writeFileSync(join(source, name), text);
  }
  writeFileSync(join(source, 'tray-files.sha256.json'), JSON.stringify(Object.entries(files).map(([name, text]) => [name, hash(text)])));
  const env = { LOCALAPPDATA: join(root, 'local') };
  const options = { source, env, shortcutDirectories: { desktop: join(root, 'desktop'), startMenu: join(root, 'programs') } };
  // Like COM Save, the fake writer rewrites the path it is given in place.
  const createShortcut = (path, target) => writeFileSync(path, target);
  // Same contract as production: refuse unless the bytes at path are exactly the
  // hashed bytes, then report what the shortcut would launch.
  const readShortcut = (path, sha256) => {
    const bytes = readFileSync(path);
    if (hash(bytes) !== sha256) throw new Error('The shortcut bytes changed before verification.');
    const target = bytes.toString('utf8');
    return { targetPath: target, arguments: '', workingDirectory: dirname(target) };
  };
  const deps = { createShortcut, readShortcut };
  return { root, source, env, options, createShortcut, deps };
}

// An installed 0.12.4 with native data and a verified 0.12.5 candidate to update to.
export function installedWindowsFixture(t) {
  const f = windowsInstallationFixture(t);
  const current = installWindowsForCurrentUser(f.options, f.deps);
  mkdirSync(current.dataDir, { recursive: true });
  writeFileSync(join(current.dataDir, 'sentinel'), 'existing user data');
  writeFileSync(join(current.dataDir, 'runtime-settings.json'), JSON.stringify({ graphRuntimeMode: 'native' }));
  const source = join(f.root, 'upgrade');
  cpSync(f.source, source, { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'fuli-context', version: '0.12.5' }));
  const inventory = JSON.parse(readFileSync(join(source, 'tray-files.sha256.json')));
  for (const entry of inventory) entry[1] = installationSha256(readFileSync(join(source, entry[0])));
  writeFileSync(join(source, 'tray-files.sha256.json'), JSON.stringify(inventory));
  const calls = [];
  // No desktop client is open; client.events records what the switch asked of it.
  const client = { events: [], state: 'absent' };
  const desktopClient = {
    close: async dataDir => { client.events.push(['close', dataDir]); return client.state; },
    reopen: installRoot => client.events.push(['reopen', installRoot]),
    followSwitch: async (installRoot, packageRoot) => { client.events.push(['followSwitch', installRoot, packageRoot]); return 'unchanged'; },
    unregister: async installRoot => { client.events.push(['unregister', installRoot]); return 'removed'; }
  };
  return { ...f, current, source, calls, client, options: { source, env: f.env },
    deps: { ...f.deps, desktopClient, acquireLock: async () => ({ assertHeld() {}, async release() {} }), runCli: async (root, args) => { calls.push({ root, args }); return { code: 0 }; },
      // A refused stop is retried without the production pause.
      stopping: { wait: async () => {} } } };
}
