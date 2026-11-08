import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cliPathPlan, cliScripts, createCliPathControl, ensureCliPath, removeCliPath, withFolderFirst, withoutFolder,
  withoutProfileBlock, withProfileBlock } from '../src/desktop/cli-path.js';
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

test('the profile block goes at the end once, and taking it out leaves the profile as it was', () => {
  const original = 'export NVM_DIR="$HOME/.nvm"\n';
  const added = withProfileBlock(original);
  assert.match(added, /^export NVM_DIR="\$HOME\/\.nvm"\n\n# >>> FULI desktop app: fl and fuli >>>\nexport PATH="\$HOME\/\.fuli\/bin:\$PATH"\n# <<< FULI desktop app <<<\n$/);
  assert.equal(withProfileBlock(added), added, 'adding again changes nothing');
  assert.equal(withoutProfileBlock(added), original);
  // A block an earlier start left above later lines moves to the end, so nvm or Homebrew never come before it.
  const moved = withProfileBlock(`${added}eval "$(brew shellenv)"\n`);
  assert.ok(moved.endsWith('# <<< FULI desktop app <<<\n'));
  assert.equal((moved.match(/>>> FULI desktop app/g) ?? []).length, 1);
  assert.equal(withoutProfileBlock(withProfileBlock('')), '');
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
  assert.equal(existsSync(join(home, '.bash_profile')), false, 'no bash profile is made for a person without one');
  assert.deepEqual(ensureCliPath(context, options).changed, [], 'a second start changes nothing');
  writeFileSync(join(home, '.bash_profile'), 'alias ll="ls -l"\n');
  ensureCliPath(context, options);
  assert.match(readFileSync(join(home, '.bash_profile'), 'utf8'), /\.fuli\/bin/);

  const control = createCliPathControl(context, options);
  assert.deepEqual(control.set(false), { supported: true, enabled: false, changed: true });
  assert.equal(readFileSync(join(home, '.bash_profile'), 'utf8'), 'alias ll="ls -l"\n');
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), '');
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
