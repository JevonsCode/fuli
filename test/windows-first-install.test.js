import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

test('first install keeps candidate bytes, binds installed default data and refuses moved/forged context', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  assert.equal(existsSync(plan.installRoot), false);
  const installed = installWindowsForCurrentUser(f.options, f.deps);
  assert.equal(installed.dataDir, join(f.env.LOCALAPPDATA, 'Fuli'));
  assert.equal(existsSync(installed.dataDir), false);
  assert.deepEqual(readFileSync(join(installed.packageRoot, 'tray-config.json')), readFileSync(join(f.source, 'tray-config.json')));
  assert.equal(loadTrayContext({ packageRoot: installed.packageRoot, env: f.env }).dataDir, installed.dataDir);
  assert.equal(resolveSetupPaths({ platform: 'win32', packageRoot: installed.packageRoot, env: f.env }).dataDir, installed.dataDir);
  assert.equal(resolveSetupPaths({ platform: 'win32', packageRoot: installed.packageRoot,
    env: { ...f.env, FULI_DATA_DIR: join(f.root, 'decoy') } }).dataDir, installed.dataDir);
  for (const path of installed.shortcuts) assert.equal(readFileSync(path, 'utf8'), join(installed.packageRoot, 'Fuli.exe'));
  assert.throws(() => installWindowsForCurrentUser(f.options, f.deps), /already exists/);
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
  assert.throws(() => installWindowsForCurrentUser(f.options, { ...f.deps, createShortcut(path, target) {
    if (++calls === 2) throw new Error('shortcut failure'); f.createShortcut(path, target);
  } }), /shortcut failure/);
  assert.equal(existsSync(plan.installRoot), false);
  assert.equal(existsSync(plan.dataDir), false);
  assert.equal(existsSync(plan.shortcuts[0]), false);
  assert.equal(installWindowsForCurrentUser(f.options, f.deps).status, 'installed');
});

test('installed bundle update refuses before npm, runtime stop or network activity', async t => {
  const f = fixture(t);
  const installed = installWindowsForCurrentUser(f.options, f.deps);
  await assert.rejects(runUpdateCommand(['--yes'], { platform: 'win32', packageRoot: installed.packageRoot,
    env: f.env, write() {}, resolveLatestVersion() { assert.fail('must not query npm'); },
    stopRuntime() { assert.fail('must not stop runtime'); } }), /not supported/);
});

test('failure cleanup preserves a shortcut replacement and unrelated files created during installation', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  let calls = 0;
  assert.throws(() => installWindowsForCurrentUser(f.options, { ...f.deps, createShortcut(path, target) {
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

const leftoverTemps = f => [f.options.shortcutDirectories.desktop, f.options.shortcutDirectories.startMenu]
  .flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith('.fuli-')) : []);

for (const failing of [1, 2]) {
  test('shortcut writer throwing after writing shortcut ' + failing + ' leaves no temporary shortcut and permits retry', t => {
    const f = fixture(t);
    const plan = planFirstWindowsInstall(f.options);
    let calls = 0;
    assert.throws(() => installWindowsForCurrentUser(f.options, { ...f.deps, createShortcut(path, target) {
      f.createShortcut(path, target);
      if (++calls === failing) throw new Error('shortcut save failed after write');
    } }), /after write/);
    assert.equal(calls, failing);
    assert.deepEqual(leftoverTemps(f), []);
    for (const path of plan.shortcuts) assert.equal(existsSync(path), false);
    assert.equal(existsSync(plan.installRoot), false);
    assert.equal(existsSync(plan.dataDir), false);
    assert.equal(installWindowsForCurrentUser(f.options, f.deps).status, 'installed');
  });
}

test('write-then-throw cleanup preserves a published shortcut that another party replaced', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  let calls = 0;
  assert.throws(() => installWindowsForCurrentUser(f.options, { ...f.deps, createShortcut(path, target) {
    f.createShortcut(path, target);
    if (++calls === 2) {
      rmSync(plan.shortcuts[0]); writeFileSync(plan.shortcuts[0], 'replacement owned by someone else');
      throw new Error('shortcut save failed after write');
    }
  } }), /after write/);
  assert.equal(readFileSync(plan.shortcuts[0], 'utf8'), 'replacement owned by someone else');
  assert.deepEqual(leftoverTemps(f), []);
  assert.equal(existsSync(join(plan.installRoot, 'versions')), false);
});

test('a foreign shortcut published during installation (EEXIST) is preserved while owned output is cleaned', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  let calls = 0;
  assert.throws(() => installWindowsForCurrentUser(f.options, { ...f.deps, createShortcut(path, target) {
    f.createShortcut(path, target);
    if (++calls === 2) writeFileSync(plan.shortcuts[1], 'foreign shortcut');
  } }), { code: 'EEXIST' });
  assert.equal(readFileSync(plan.shortcuts[1], 'utf8'), 'foreign shortcut');
  assert.equal(existsSync(plan.shortcuts[0]), false);
  assert.deepEqual(leftoverTemps(f), []);
  assert.equal(existsSync(plan.installRoot), false);
});

const installedFiles = f => [f.options.shortcutDirectories.desktop, f.options.shortcutDirectories.startMenu]
  .flatMap(dir => existsSync(dir) ? readdirSync(dir) : []);
const inode = path => fs.lstatSync(path, { bigint: true }).ino;

test('only private staging is used; shared folders never hold a temporary name and verified bytes are published', t => {
  const f = fixture(t);
  const seen = [], verified = [], listings = [];
  const installed = installWindowsForCurrentUser(f.options, {
    createShortcut(path, target) { seen.push(path); listings.push(installedFiles(f)); f.createShortcut(path, target); },
    readShortcut(path, sha256) { verified.push(sha256); listings.push(installedFiles(f)); return f.deps.readShortcut(path, sha256); }
  });
  for (const path of seen) {
    assert.equal(dirname(dirname(path)), installed.packageRoot);
    assert.equal(existsSync(path), false);
  }
  assert.equal(existsSync(dirname(seen[0])), false, 'staging is removed after publication');
  for (const listing of listings) assert.deepEqual(listing.filter(name => name !== 'Fuli.lnk'), []);
  assert.deepEqual(installedFiles(f).sort(), ['Fuli.lnk', 'Fuli.lnk']);
  assert.deepEqual(installed.shortcuts.map(path => hash(readFileSync(path))), verified, 'published bytes are the verified bytes');
  for (const path of installed.shortcuts) assert.equal(readFileSync(path, 'utf8'), join(installed.packageRoot, 'Fuli.exe'));
});

test('a file another party creates at the final name after verification is never written into or published as installed', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  let foreignIno;
  assert.throws(() => installWindowsForCurrentUser(f.options, { ...f.deps, readShortcut(path, sha256) {
    const link = f.deps.readShortcut(path, sha256);
    if (!foreignIno) { writeFileSync(plan.shortcuts[0], 'foreign shortcut', { flag: 'wx' }); foreignIno = inode(plan.shortcuts[0]); }
    return link;
  } }), { code: 'EEXIST' });
  assert.equal(readFileSync(plan.shortcuts[0], 'utf8'), 'foreign shortcut');
  assert.equal(inode(plan.shortcuts[0]), foreignIno, 'the final name still holds only the foreign inode');
  assert.equal(existsSync(plan.shortcuts[1]), false);
  assert.equal(existsSync(plan.installRoot), false);
});

test('a source swapped just before any hard-link publication never becomes a final shortcut', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  const originalLink = fs.linkSync;
  let swaps = 0, outcome;
  t.mock.method(fs, 'linkSync', (source, destination) => {
    swaps++; renameSync(source, source + '.aside'); writeFileSync(source, 'foreign temp', { flag: 'wx' });
    return originalLink(source, destination);
  });
  syncBuiltinESMExports();
  try { outcome = installWindowsForCurrentUser(f.options, f.deps).status; } catch (error) { outcome = error.message; }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  for (const path of plan.shortcuts) {
    if (existsSync(path)) assert.notEqual(readFileSync(path, 'utf8'), 'foreign temp', 'outcome: ' + outcome);
  }
  assert.equal(swaps, 0, 'publication does not go through a linkable shared temporary file');
  assert.equal(outcome, 'installed');
});

test('a path-reader decoy cannot validate different bytes than the ones published', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  const wrong = 'C:\\elsewhere\\not-fuli.exe';
  assert.throws(() => installWindowsForCurrentUser(f.options, {
    createShortcut: path => writeFileSync(path, wrong),
    readShortcut(path, sha256) {
      // Another party shows the reader a correct-looking file, then restores the original.
      renameSync(path, path + '.aside'); writeFileSync(path, join(dirname(dirname(path)), 'Fuli.exe'));
      try { return f.deps.readShortcut(path, sha256); }
      finally { rmSync(path); renameSync(path + '.aside', path); }
    }
  }), /changed before verification/);
  for (const path of plan.shortcuts) assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(plan.installRoot, 'installation.json')), false);
});

for (const [label, change] of [['rewritten in place', (path, original) => original(path, 'C:\\elsewhere\\evil.exe')],
  ['renamed aside and replaced', (path, original) => { renameSync(path, path + '.moved'); original(path, 'foreign at final', { flag: 'wx' }); }]]) {
  test('a final shortcut ' + label + ' while it is written fails closed and is not recorded as installed', t => {
    const f = fixture(t);
    const plan = planFirstWindowsInstall(f.options);
    const originalWrite = fs.writeFileSync, originalRead = fs.readSync;
    let changed = false;
    t.mock.method(fs, 'readSync', (fd, ...args) => {
      if (!changed && existsSync(plan.shortcuts[0])) { changed = true; change(plan.shortcuts[0], originalWrite); }
      return originalRead(fd, ...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => installWindowsForCurrentUser(f.options, f.deps), /changed while it was written|replaced while it was written/);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(changed, true);
    assert.equal(existsSync(join(plan.installRoot, 'installation.json')), false);
    assert.equal(existsSync(plan.shortcuts[1]), false);
    if (label.startsWith('renamed')) {
      assert.equal(readFileSync(plan.shortcuts[0], 'utf8'), 'foreign at final', 'another party\'s file is preserved');
    } else assert.equal(existsSync(plan.shortcuts[0]), false, 'the installer\'s own tampered inode is removed');
  });
}

for (const throws of [true, false]) {
  test('writer output replaced in staging then ' + (throws ? 'throwing' : 'returning') + ' preserves the replacement and publishes nothing', t => {
    const f = fixture(t);
    const plan = planFirstWindowsInstall(f.options);
    let staged;
    assert.throws(() => installWindowsForCurrentUser(f.options, { ...f.deps, createShortcut(path, target) {
      staged = path; f.createShortcut(path, target);
      rmSync(path); writeFileSync(path, join(plan.installRoot, 'versions', 'x', 'Fuli.exe'), { flag: 'wx' });
      if (throws) throw new Error('writer failed after replacement');
    } }), throws ? /after replacement/ : /installer-owned staging file/);
    assert.equal(readFileSync(staged, 'utf8'), join(plan.installRoot, 'versions', 'x', 'Fuli.exe'), 'the replacement is left for inspection');
    for (const path of plan.shortcuts) assert.equal(existsSync(path), false);
    assert.deepEqual(installedFiles(f), []);
    assert.equal(existsSync(join(plan.installRoot, 'installation.json')), false);
  });
}

for (const [label, write] of [['writes nothing', () => {}], ['writes a different target', path => writeFileSync(path, 'C:\\elsewhere\\not-fuli.exe')]]) {
  test('a writer that ' + label + ' is rejected, cleaned and retried without publishing', t => {
    const f = fixture(t);
    const plan = planFirstWindowsInstall(f.options);
    assert.throws(() => installWindowsForCurrentUser(f.options, { ...f.deps, createShortcut: write }),
      /produced no shortcut|does not point at the installed application/);
    assert.deepEqual(installedFiles(f), []);
    assert.equal(existsSync(plan.installRoot), false);
    assert.equal(installWindowsForCurrentUser(f.options, f.deps).status, 'installed');
  });
}

test('staged bytes rewritten in place after verification never reach a published shortcut', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  let staged;
  assert.throws(() => installWindowsForCurrentUser(f.options, { ...f.deps, readShortcut(path, sha256) {
    const link = f.deps.readShortcut(path, sha256);
    if (!staged) { staged = path; writeFileSync(path, 'C:\\elsewhere\\evil.exe'); }
    return link;
  } }));
  assert.equal(readFileSync(staged, 'utf8'), 'C:\\elsewhere\\evil.exe', 'the tampered staging file is left for inspection');
  for (const path of plan.shortcuts) assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(plan.installRoot, 'installation.json')), false);
});

test('a reader reporting arguments or another working directory is rejected', t => {
  for (const extra of [{ arguments: '--evil' }, { workingDirectory: 'C:\\elsewhere' }]) {
    const f = fixture(t);
    const plan = planFirstWindowsInstall(f.options);
    assert.throws(() => installWindowsForCurrentUser(f.options, { ...f.deps,
      readShortcut: (path, sha256) => ({ ...f.deps.readShortcut(path, sha256), ...extra }) }), /does not point at the installed application/);
    assert.deepEqual(installedFiles(f), []);
    assert.equal(existsSync(plan.installRoot), false);
  }
});

for (const code of ['ENOSPC', 'EIO']) {
  test('a partial file write throwing ' + code + ' cleans owned bytes and permits first-install retry', t => {
    const f = fixture(t);
    const plan = planFirstWindowsInstall(f.options);
    const originalWrite = fs.writeFileSync;
    let injected = false;
    t.mock.method(fs, 'writeFileSync', (target, bytes, ...args) => {
      if (!injected) {
        injected = true;
        originalWrite(target, Buffer.from(bytes).subarray(0, 4), ...args);
        throw Object.assign(new Error('partial disk write'), { code });
      }
      return originalWrite(target, bytes, ...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => installWindowsForCurrentUser(f.options, f.deps), { code });
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.equal(existsSync(plan.installRoot), false);
    assert.equal(existsSync(plan.dataDir), false);
    assert.equal(installWindowsForCurrentUser(f.options, f.deps).status, 'installed');
  });
}

test('partial-write cleanup never follows a replaced destination away from its opened inode', t => {
  const f = fixture(t);
  const plan = planFirstWindowsInstall(f.options);
  const originalWrite = fs.writeFileSync;
  let injected = false;
  let destination;
  t.mock.method(fs, 'writeFileSync', (target, bytes, ...args) => {
    if (!injected) {
      injected = true;
      originalWrite(target, Buffer.from(bytes).subarray(0, 4), ...args);
      destination = join(plan.installRoot, 'versions', readdirSync(join(plan.installRoot, 'versions'))[0], 'package.json');
      renameSync(destination, destination + '.moved');
      originalWrite(destination, 'replacement must survive', { flag: 'wx' });
      throw Object.assign(new Error('partial disk write with replacement'), { code: 'EIO' });
    }
    return originalWrite(target, bytes, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => installWindowsForCurrentUser(f.options, f.deps), { code: 'EIO' });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(readFileSync(destination, 'utf8'), 'replacement must survive');
  assert.equal(existsSync(plan.dataDir), false);
  assert.equal(existsSync(join(plan.installRoot, 'installation.json')), false);
});
