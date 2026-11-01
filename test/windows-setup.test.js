import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { windowsInstallationFixture as fixture } from './fixtures/windows-installation.js';
import { SETUP_SCRIPT, buildWindowsSetup, setupCompileArguments, setupFileName, setupTrayFiles } from '../scripts/build-windows-setup.js';

// FULI-Setup-<version>.exe (desktop/windows-setup/fuli-setup.iss). ISCC only
// runs on Windows in CI; these checks keep the script honest everywhere.

const root = fileURLToPath(new URL('../', import.meta.url));
const script = readFileSync(SETUP_SCRIPT, 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// What scripts/build-windows-tray.js adds to the npm-packed application.
const TRAY_BUILT = ['Fuli.exe', 'FuliNode.exe', 'runtime/node/node.exe'];

test('the setup names only files of the tray layout', () => {
  const files = setupTrayFiles(script);
  assert.ok(files.length >= 5, 'the tray files are declared as #define Tray... constants');
  for (const file of files) {
    if (TRAY_BUILT.includes(file)) continue;
    assert.ok(file.startsWith('src/') && packageJson.files.includes('src/'), file + ' is packed into the tray');
    assert.ok(existsSync(join(root, file)), file + ' exists');
  }
  for (const command of ['windows-install.js', 'windows-update-command.js', 'windows-uninstall-command.js']) {
    assert.ok(files.includes('src/desktop/' + command), 'the setup runs ' + command);
  }
  // Every tray path the [Code] and [Run] sections use goes through those constants.
  const body = script.replace(/^#define.*$/gm, '').replace(/^;.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(body, /\\src\\|\\runtime\\|Fuli\.exe|FuliNode\.exe/i, 'no tray path is spelled out twice');
});

test('the setup takes its version from the tray package.json and carries no version of its own', async (t) => {
  assert.doesNotMatch(script, /AppVersion=\d|#define\s+AppVersion/, 'no version is written into the script');
  assert.match(script, /AppVersion=\{#AppVersion\}/);
  assert.match(script, /#ifndef AppVersion\s+#error/);

  const tray = mkdtempSync(join(tmpdir(), 'fuli-setup-'));
  t.after(() => rmSync(tray, { recursive: true, force: true }));
  writeFileSync(join(tray, 'package.json'), JSON.stringify({ name: 'fuli-context', version: packageJson.version }));
  const output = join(tray, 'out');
  const compile = await setupCompileArguments({ tray, output });
  assert.equal(compile.version, packageJson.version);
  assert.equal(compile.name, setupFileName(packageJson.version));
  assert.equal(compile.name, `FULI-Setup-${packageJson.version}.exe`);
  assert.deepEqual(compile.args, ['/Q', `/DAppVersion=${packageJson.version}`, `/DTrayDir=${tray}`, `/DOutputDir=${output}`,
    `/DOutputBaseFilename=FULI-Setup-${packageJson.version}`, SETUP_SCRIPT]);

  writeFileSync(join(tray, 'package.json'), JSON.stringify({ name: 'fuli-context', version: '9.8.7-beta.6' }));
  assert.equal((await setupCompileArguments({ tray, output })).name, 'FULI-Setup-9.8.7-beta.6.exe');
});

test('the setup is per-user, keeps the existing uninstall, and its own files exist', () => {
  assert.match(script, /^PrivilegesRequired=lowest$/m);
  assert.match(script, /^AppName=FULI$/m);
  assert.match(script, /^AppPublisher=JevonsCode$/m);
  assert.match(script, /^Uninstallable=no$/m);
  assert.match(script, /^CreateUninstallRegKey=no$/m);
  const directory = dirname(SETUP_SCRIPT);
  const icon = /^SetupIconFile=(.+)$/m.exec(script)[1].trim();
  assert.ok(existsSync(join(directory, icon)), 'the brand icon ' + icon + ' exists');
  assert.equal(join(directory, icon), join(root, 'brand', 'png', 'app-icon', 'fuli-app.ico'));
  for (const [, files] of script.matchAll(/MessagesFile: "([^"]+)"/g)) {
    for (const file of files.split(',').filter(name => !name.startsWith('compiler:'))) {
      assert.ok(existsSync(join(directory, file)), file + ' exists');
    }
  }
  assert.match(script, /^Name: "zh";/m);
  assert.match(script, /^Name: "en";/m);
  // Every custom message has both languages.
  const messages = [...script.matchAll(/^(zh|en)\.(\w+)=/gm)];
  const names = new Set(messages.map(([, , name]) => name));
  for (const name of names) {
    assert.ok(messages.some(([, lang, n]) => lang === 'zh' && n === name), name + ' has Chinese');
    assert.ok(messages.some(([, lang, n]) => lang === 'en' && n === name), name + ' has English');
    assert.match(script, new RegExp(`(CustomMessage\\('${name}'\\)|\\{cm:${name}\\})`), name + ' is used');
  }
});

test('the build refuses a tray without a file the setup runs, before ISCC starts', { skip: process.platform !== 'win32' }, async (t) => {
  const f = fixture(t);
  // The fixture tray is verified but carries no src/desktop/windows-install.js;
  // iscc is any existing file, since it must never be reached.
  await assert.rejects(buildWindowsSetup({ tray: f.source, output: join(f.root, 'setup'), iscc: process.execPath }),
    /The tray directory has no src\/desktop\/windows-install\.js for the setup\./);
  assert.equal(existsSync(join(f.root, 'setup')), false);
});
