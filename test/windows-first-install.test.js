import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { installWindowsForCurrentUser, planFirstWindowsInstall } from '../src/desktop/windows-installation.js';
import { loadTrayContext } from '../src/desktop/windows-controller.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { runUpdateCommand } from '../src/cli/update-command.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-first-install-'));
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); });
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
    'node_modules/example/index.js': '', 'src/cli.js': '', 'src/desktop/windows-controller.js': '', 'Fuli.exe': ''
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(source, name)), { recursive: true }); writeFileSync(join(source, name), text);
  }
  writeFileSync(join(source, 'tray-files.sha256.json'), JSON.stringify(Object.entries(files).map(([name, text]) => [name, hash(text)])));
  const env = { LOCALAPPDATA: join(root, 'local') };
  const options = { source, env, shortcutDirectories: { desktop: join(root, 'desktop'), startMenu: join(root, 'programs') } };
  const createShortcut = (path, target) => writeFileSync(path, target, { flag: 'wx' });
  return { root, source, env, options, createShortcut };
}

test('first install keeps candidate bytes, binds installed default data and refuses moved/forged context', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  assert.equal(existsSync(plan.installRoot), false);
  const installed = installWindowsForCurrentUser(f.options, { createShortcut: f.createShortcut });
  assert.equal(installed.dataDir, join(f.env.LOCALAPPDATA, 'Fuli'));
  assert.equal(existsSync(installed.dataDir), false);
  assert.deepEqual(readFileSync(join(installed.packageRoot, 'tray-config.json')), readFileSync(join(f.source, 'tray-config.json')));
  assert.equal(loadTrayContext({ packageRoot: installed.packageRoot, env: f.env }).dataDir, installed.dataDir);
  assert.equal(resolveSetupPaths({ platform: 'win32', packageRoot: installed.packageRoot, env: f.env }).dataDir, installed.dataDir);
  assert.equal(resolveSetupPaths({ platform: 'win32', packageRoot: installed.packageRoot,
    env: { ...f.env, FULI_DATA_DIR: join(f.root, 'decoy') } }).dataDir, installed.dataDir);
  for (const path of installed.shortcuts) assert.equal(readFileSync(path, 'utf8'), join(installed.packageRoot, 'Fuli.exe'));
  assert.throws(() => installWindowsForCurrentUser(f.options, { createShortcut: f.createShortcut }), /already exists/);
  const moved = installed.packageRoot + '-moved';
  renameSync(installed.packageRoot, moved);
  assert.throws(() => loadTrayContext({ packageRoot: moved, env: f.env }), /installation record/);
  renameSync(moved, installed.packageRoot);
  const recordPath = join(installed.installRoot, 'installation.json');
  const record = JSON.parse(readFileSync(recordPath)); record.dataDir = join(f.root, 'other'); writeFileSync(recordPath, JSON.stringify(record));
  assert.throws(() => loadTrayContext({ packageRoot: installed.packageRoot, env: f.env }), /installation record/);
});

test('first install refuses existing native/container data, changed payload and preexisting shortcuts without mutation', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  mkdirSync(plan.dataDir, { recursive: true }); writeFileSync(join(plan.dataDir, 'graph-runtime.json'), 'preserve');
  assert.throws(() => planFirstWindowsInstall(f.options), /data directory already exists/);
  assert.equal(readFileSync(join(plan.dataDir, 'graph-runtime.json'), 'utf8'), 'preserve');
  assert.equal(existsSync(plan.installRoot), false);
  rmSync(plan.dataDir, { recursive: true });
  const shortcut = join(f.options.shortcutDirectories.desktop, 'Fuli.lnk');
  mkdirSync(dirname(shortcut), { recursive: true }); writeFileSync(shortcut, 'someone else');
  assert.throws(() => planFirstWindowsInstall(f.options), /shortcut already exists/);
  assert.equal(readFileSync(shortcut, 'utf8'), 'someone else'); rmSync(shortcut);
  writeFileSync(join(f.source, 'Fuli.exe'), 'changed');
  assert.throws(() => planFirstWindowsInstall(f.options), /checksum/);
  assert.equal(existsSync(plan.installRoot), false);
});

test('interrupted shortcut creation removes only owned files and permits a clean retry', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  let calls = 0;
  assert.throws(() => installWindowsForCurrentUser(f.options, { createShortcut(path, target) {
    if (++calls === 2) throw new Error('shortcut failure'); f.createShortcut(path, target);
  } }), /shortcut failure/);
  assert.equal(existsSync(plan.installRoot), false);
  assert.equal(existsSync(plan.dataDir), false);
  assert.equal(existsSync(plan.shortcuts[0]), false);
  assert.equal(installWindowsForCurrentUser(f.options, { createShortcut: f.createShortcut }).status, 'installed');
});

test('installed bundle update refuses before npm, runtime stop or network activity', async t => {
  const f = fixture(t);
  const installed = installWindowsForCurrentUser(f.options, { createShortcut: f.createShortcut });
  await assert.rejects(runUpdateCommand(['--yes'], { platform: 'win32', packageRoot: installed.packageRoot,
    env: f.env, write() {}, resolveLatestVersion() { assert.fail('must not query npm'); },
    stopRuntime() { assert.fail('must not stop runtime'); } }), /not supported/);
});

test('failure cleanup preserves a shortcut replacement and unrelated files created during installation', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  let calls = 0;
  assert.throws(() => installWindowsForCurrentUser(f.options, { createShortcut(path, target) {
    if (++calls === 2) {
      writeFileSync(plan.shortcuts[0], 'replacement owned by someone else');
      writeFileSync(join(plan.installRoot, 'unrelated.txt'), 'preserve');
      throw new Error('second shortcut failed');
    }
    f.createShortcut(path, target);
  } }), /second shortcut failed/);
  assert.equal(readFileSync(plan.shortcuts[0], 'utf8'), 'replacement owned by someone else');
  assert.equal(readFileSync(join(plan.installRoot, 'unrelated.txt'), 'utf8'), 'preserve');
  assert.equal(existsSync(join(plan.installRoot, 'installation.json')), false);
  assert.equal(existsSync(join(plan.installRoot, 'versions')), false);
});
