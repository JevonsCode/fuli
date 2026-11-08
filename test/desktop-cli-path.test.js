import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cliPathPlan, cliScripts, createCliPathControl, decodeUserPathOutput, encodeUserPath, ensureCliPath, profileAddition,
  removeCliPath, withFolderFirst, withoutFolder, withoutProfileBlock } from '../src/desktop/cli-path.js';
import { handleCliPathRequest } from '../src/http/cli-path-api-router.js';

// The desktop app's own fl and fuli on PATH. Synthetic home folders and a fake
// Windows user PATH only: no real shell profile, registry or PATH is touched.

const APP = '/Applications/FULI.app/Contents/Resources/fuli';

function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fuli-cli-path-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const fakeUserPath = (value) => {
  const state = { value, writes: 0 };
  return { state, port: { read: () => state.value, write: (next) => { state.value = next; state.writes += 1; } } };
};

test('the profile block is added once at the end, and taking it out restores the profile byte for byte', () => {
  for (const original of ['export NVM_DIR="$HOME/.nvm"\n', 'alias ll="ls -l"', 'a\n\n\n', '']) {
    const addition = profileAddition(original);
    assert.ok(addition.text.startsWith(original));
    assert.match(addition.text, /# >>> FULI desktop app: fl and fuli >>>\nexport PATH="\$HOME\/\.fuli\/bin:\$PATH"\n# <<< FULI desktop app <<<\n$/);
    assert.equal(withoutProfileBlock(addition.text, addition.separator), original, JSON.stringify(original));
    assert.equal(profileAddition(addition.text), null, 'a profile with the block is not written again');
  }
  // A block the person moved above later lines is taken out alone.
  const moved = profileAddition('x\n').text + 'eval "$(brew shellenv)"\n';
  assert.equal(withoutProfileBlock(moved, '\n'), 'x\n\neval "$(brew shellenv)"\n');
});

test('a user PATH with Chinese folders and %VARS% survives reading, editing and writing', () => {
  const bin = 'C:\\Users\\张三\\AppData\\Local\\Programs\\Fuli\\bin';
  const value = '%USERPROFILE%\\工具;D:\\开发\\node;C:\\nvm4w\\nodejs';
  const read = decodeUserPathOutput(Buffer.from(value, 'utf8').toString('base64') + '\r\n');
  assert.equal(read, value);
  const written = withFolderFirst(read, bin);
  assert.equal(Buffer.from(encodeUserPath(written), 'base64').toString('utf8'), `${bin};${value}`);
  assert.equal(withoutFolder(written, bin), value);
  assert.equal(decodeUserPathOutput('NONE\r\n'), '', 'no user PATH yet is an empty one');
  assert.equal(decodeUserPathOutput('Path    REG_EXPAND_SZ    D:\\��\\node'), null, 'anything else is never written over');
});

test('the Windows user PATH gets the folder first, once, and keeps every other entry as written', () => {
  const bin = 'C:\\Users\\a\\AppData\\Local\\Programs\\Fuli\\bin';
  const value = '%USERPROFILE%\\.local\\bin;C:\\Users\\a\\AppData\\Local\\Programs\\fuli\\BIN\\;C:\\nvm4w\\nodejs';
  assert.equal(withFolderFirst(value, bin), `${bin};%USERPROFILE%\\.local\\bin;C:\\nvm4w\\nodejs`);
  assert.equal(withoutFolder(withFolderFirst(value, bin), bin), '%USERPROFILE%\\.local\\bin;C:\\nvm4w\\nodejs');
  assert.equal(withFolderFirst('', bin), bin);
});

test('macOS: the commands run the app\'s own Node and CLI, and say so when the app moved', () => {
  const plan = cliPathPlan({ packageRoot: APP }, { platform: 'darwin', homeDir: '/Users/synthetic' });
  assert.equal(plan.binDir, '/Users/synthetic/.fuli/bin'.replaceAll('/', plan.binDir.includes('\\') ? '\\' : '/'));
  const fl = cliScripts(plan).fl;
  assert.match(fl, /^#!\/bin\/sh\n/);
  assert.match(fl, /exec '\/Applications\/FULI\.app\/Contents\/Resources\/fuli\/runtime\/node\/bin\/node' '\/Applications\/FULI\.app\/Contents\/Resources\/fuli\/src\/cli\.js' "\$@"/);
  assert.match(fl, /FULI\.app is no longer at \/Applications\/FULI\.app/);
  assert.equal(cliPathPlan({ packageRoot: '/Volumes/FULI/FULI.app/Contents/Resources/fuli' }, { platform: 'darwin' }), null,
    'an app run from its disk image gets no commands');
  assert.equal(cliPathPlan({ packageRoot: 'C:\\portable' }, { platform: 'win32' }), null, 'a portable tray gets none');
  assert.match(cliScripts({ platform: 'win32', installRoot: 'C:\\F' })['fl.cmd'], /"%~dp0\.\.\\FuliNode\.exe" src\\cli\.js %\*/);
});

test('macOS: turning on writes the scripts and the zsh block once; turning off undoes exactly that', t => {
  const home = temporary(t);
  const dataDir = join(home, 'data');
  mkdirSync(dataDir);
  const context = { dataDir, packageRoot: APP };
  const options = { platform: 'darwin', homeDir: home };
  const first = ensureCliPath(context, options);
  assert.equal(first.status, 'on');
  assert.equal(readFileSync(join(home, '.fuli', 'bin', 'fl'), 'utf8'), cliScripts(cliPathPlan(context, options)).fl);
  assert.ok(existsSync(join(home, '.fuli', 'bin', 'fuli')));
  assert.match(readFileSync(join(home, '.zshrc'), 'utf8'), /\.fuli\/bin/);
  assert.deepEqual(readdirSync(home).filter((name) => name.includes('.tmp')), [], 'written in one step, no temporary left');
  assert.equal(existsSync(join(home, '.bash_profile')), false, 'no bash profile is made for a person without one');
  assert.deepEqual(ensureCliPath(context, options).changed, [], 'a second start changes nothing');
  writeFileSync(join(home, '.bash_profile'), 'alias ll="ls -l"\n');
  ensureCliPath(context, options);
  assert.match(readFileSync(join(home, '.bash_profile'), 'utf8'), /\.fuli\/bin/);

  const control = createCliPathControl(context, options);
  assert.deepEqual(control.set(false), { supported: true, enabled: false, changed: true });
  assert.equal(readFileSync(join(home, '.bash_profile'), 'utf8'), 'alias ll="ls -l"\n');
  assert.equal(existsSync(join(home, '.zshrc')), false, 'a .zshrc FULI made goes away again');
  assert.equal(existsSync(join(home, '.fuli', 'bin')), false);
  assert.deepEqual(ensureCliPath(context, options), { status: 'off', changed: [] }, 'turned off stays off at the next start');
  assert.equal(control.set(true).enabled, true);
  assert.ok(existsSync(join(home, '.fuli', 'bin', 'fl')));
});

test('Windows: the folder goes first in the user PATH; an unreadable PATH is never written', t => {
  const installRoot = temporary(t);
  const context = { dataDir: null, installRoot };
  const bin = join(installRoot, 'bin');
  const user = fakeUserPath('C:\\nvm4w\\nodejs;%USERPROFILE%\\bin');
  ensureCliPath(context, { platform: 'win32', userPath: user.port });
  assert.equal(user.state.value, `${bin};C:\\nvm4w\\nodejs;%USERPROFILE%\\bin`);
  assert.ok(existsSync(join(bin, 'fl.cmd')) && existsSync(join(bin, 'fuli.cmd')));
  ensureCliPath(context, { platform: 'win32', userPath: user.port });
  assert.equal(user.state.writes, 1, 'already first: nothing written');
  const unreadable = fakeUserPath(null);
  ensureCliPath(context, { platform: 'win32', userPath: unreadable.port });
  assert.equal(unreadable.state.writes, 0);
  removeCliPath(context, { platform: 'win32', userPath: user.port });
  assert.equal(user.state.value, 'C:\\nvm4w\\nodejs;%USERPROFILE%\\bin');
  assert.equal(existsSync(bin), false);
  const untouched = fakeUserPath('C:\\x');
  removeCliPath(context, { platform: 'win32', userPath: { read: () => assert.fail('no commands, no PATH read'), write: untouched.port.write } });
});

test('only this computer turns the terminal commands on or off', async () => {
  const call = async (method, address, system) => {
    const sent = {};
    const response = { setHeader() {}, writeHead: (status) => { sent.status = status; }, end: (text) => { sent.body = JSON.parse(text); } };
    const request = { method, socket: { remoteAddress: address } };
    try {
      await handleCliPathRequest({ request, response, url: new URL('http://127.0.0.1/api/system/cli-path'), system });
    } catch (error) { sent.error = error.message; }
    return sent;
  };
  const system = { cliPath: { status: () => ({ supported: true, enabled: true }), set: () => assert.fail('never from afar') } };
  assert.deepEqual((await call('GET', '192.168.1.9', system)).body, { supported: true, enabled: true });
  assert.equal((await call('PUT', '192.168.1.9', system)).status, 403);
  assert.deepEqual((await call('GET', '127.0.0.1', {})).body, { supported: false, enabled: false });
  assert.equal((await call('POST', '127.0.0.1', system)).status, 405);
});
