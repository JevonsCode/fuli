import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { findInLoginShellPath, forgetLoginShellPath, loginShellPath, withLoginShellPath }
  from '../packages/roundtable/src/roundtable/login-shell-path.js';

// A fake shell that answers the PATH between the marks, with a greeting line before it as an interactive shell may print.
const MARK = '__FULI_LOGIN_PATH__';
const shellAnswering = (path, calls = []) => (shell, args, options) => {
  calls.push({ shell, args, timeout: options.timeout });
  return { status: 0, stdout: `Welcome back
${MARK}${path}${MARK}` };
};
const LOGIN = ['/synthetic/home/.local/bin', '/opt/synthetic/bin'].join(delimiter);

test('the login shell is asked once, as a login and interactive shell, and its PATH is kept for a few minutes', () => {
  forgetLoginShellPath();
  const calls = [];
  let time = 1_000;
  const options = { env: { SHELL: '/bin/zsh', PATH: '/usr/bin' }, platform: 'darwin', run: shellAnswering(LOGIN, calls), now: () => time };
  assert.equal(loginShellPath(options), LOGIN);
  assert.equal(loginShellPath(options), LOGIN);
  assert.deepEqual(calls.map((call) => [call.shell, call.args[0]]), [['/bin/zsh', '-lic']], 'asked once');
  assert.ok(calls[0].timeout > 0, 'a shell that hangs is stopped');
  time += 6 * 60_000;
  loginShellPath(options);
  assert.equal(calls.length, 2, 'asked again once the answer is old');
});

test('an application started by the desktop has no SHELL: the account shell is used, and fish falls back to sh', () => {
  forgetLoginShellPath();
  const calls = [];
  loginShellPath({ env: { PATH: '/usr/bin' }, platform: 'darwin', run: shellAnswering(LOGIN, calls), accountShell: () => '/bin/zsh' });
  forgetLoginShellPath();
  loginShellPath({ env: { SHELL: '/opt/homebrew/bin/fish', PATH: '/usr/bin' }, platform: 'darwin', run: shellAnswering(LOGIN, calls) });
  assert.deepEqual(calls.map((call) => call.shell), ['/bin/zsh', '/bin/sh']);
});

test('a shell that fails, hangs, answers nothing or cannot start teaches nothing and is not asked again at once', () => {
  for (const run of [() => ({ status: 1, stdout: '' }), () => ({ status: null, signal: 'SIGTERM', stdout: '' }),
    () => ({ status: 0, stdout: 'no marks here' }), () => { throw new Error('spawn failed'); }]) {
    forgetLoginShellPath();
    let asked = 0;
    const options = { env: { SHELL: '/bin/zsh' }, platform: 'darwin', run: (...args) => { asked += 1; return run(...args); }, now: () => 5 };
    assert.equal(loginShellPath(options), null);
    assert.equal(loginShellPath(options), null);
    assert.equal(asked, 1);
    assert.deepEqual(withLoginShellPath({ PATH: '/usr/bin' }), { PATH: '/usr/bin' }, 'nothing learned, nothing added');
  }
});

test('nothing is asked on Windows', () => {
  forgetLoginShellPath();
  assert.equal(loginShellPath({ platform: 'win32', run: () => assert.fail('no shell on Windows') }), null);
  assert.equal(findInLoginShellPath('claude', { platform: 'win32', run: () => assert.fail('no shell on Windows') }), null);
});

test('a command is found in the first login directory that holds it as a program', () => {
  forgetLoginShellPath();
  const programs = new Set([join('/opt/synthetic/bin', 'claude'), join('/synthetic/home/.local/bin', 'codex')]);
  const options = { env: { SHELL: '/bin/zsh', PATH: '/usr/bin' }, platform: 'darwin', run: shellAnswering(LOGIN),
    isProgram: (file) => programs.has(file) };
  assert.equal(findInLoginShellPath('claude', options), join('/opt/synthetic/bin', 'claude'));
  assert.equal(findInLoginShellPath('codex', options), join('/synthetic/home/.local/bin', 'codex'));
  assert.equal(findInLoginShellPath('missing', options), null);
});

test('a client is started with the login directories after FULI’s own, only once they were learned', () => {
  forgetLoginShellPath();
  const own = { PATH: ['/usr/bin', '/opt/synthetic/bin'].join(delimiter), OTHER: 'kept' };
  assert.equal(withLoginShellPath(own), own, 'not learned yet: the environment is not touched and no shell is started');
  loginShellPath({ env: { SHELL: '/bin/zsh' }, platform: 'darwin', run: shellAnswering(LOGIN) });
  assert.deepEqual(withLoginShellPath(own), { PATH: ['/usr/bin', '/opt/synthetic/bin', '/synthetic/home/.local/bin'].join(delimiter), OTHER: 'kept' });
  const covered = { PATH: ['/synthetic/home/.local/bin', '/opt/synthetic/bin'].join(delimiter) };
  assert.equal(withLoginShellPath(covered), covered, 'nothing to add');
  forgetLoginShellPath();
});
