import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopClientOpensLinks } from '../src/desktop/desktop-client-links.js';
import { handleDesktopClientRequest } from '../src/http/desktop-client-api-router.js';

const INSTALL_ROOT = 'C:\\Users\\synthetic\\AppData\\Local\\Programs\\Fuli';
const LAUNCHER = `"${INSTALL_ROOT}\\versions\\00000000-0000-4000-8000-000000000001\\Fuli.exe" "%1"`;
const installed = () => ({ installRoot: INSTALL_ROOT });

test('only a Windows installation or the macOS app opens fuli:// links', () => {
  const never = () => { throw new Error('not read off Windows'); };
  assert.equal(desktopClientOpensLinks({ platform: 'linux', readInstallation: never, readCommand: never })(), false);
  assert.equal(desktopClientOpensLinks({ platform: 'darwin', packageRoot: '/Applications/FULI.app/Contents/Resources/fuli',
    isAppPackage: (root, { platform }) => platform === 'darwin' && root.includes('.app/'), readCommand: never })(), true);
  assert.equal(desktopClientOpensLinks({ platform: 'darwin', packageRoot: '/usr/local/lib/node_modules/fuli',
    isAppPackage: () => false })(), false, 'an npm installation on macOS');
  assert.equal(desktopClientOpensLinks({ platform: 'win32', readInstallation: () => null, readCommand: () => LAUNCHER })(), false);
  assert.equal(desktopClientOpensLinks({ platform: 'win32', readInstallation: () => { throw new Error('moved'); },
    readCommand: () => LAUNCHER })(), false);
});

test('on Windows the scheme must open this installation\'s launcher', () => {
  const opens = (command) => desktopClientOpensLinks({ platform: 'win32', readInstallation: installed, readCommand: () => command })();
  assert.equal(opens(LAUNCHER), true);
  assert.equal(opens(null), false, 'no scheme registered: the client never ran');
  assert.equal(opens('"C:\\Users\\synthetic\\Other\\Fuli.exe" "%1"'), false, 'another installation');
  assert.equal(opens(`"${INSTALL_ROOT}\\versions\\x\\client\\FULI.exe" "%1"`), false, 'not the launcher');
});

test('the Windows scheme is read at most once a minute', () => {
  let reads = 0;
  let clock = 0;
  const opens = desktopClientOpensLinks({ platform: 'win32', readInstallation: installed, now: () => clock,
    readCommand: () => { reads += 1; return reads === 1 ? null : LAUNCHER; } });
  assert.equal(opens(), false);
  clock = 59_000;
  assert.equal(opens(), false);
  clock = 60_000;
  assert.equal(opens(), true, 'a client registered since the last read');
  assert.equal(reads, 2);
});

function call(system, method, path = '/api/system/desktop-client') {
  let sent;
  const response = { writeHead: (status) => { sent = { status }; }, setHeader: () => {}, end: (text) => { sent.body = JSON.parse(text); } };
  return handleDesktopClientRequest({ request: { method }, response, url: new URL(`http://127.0.0.1${path}`), system }) ? sent : null;
}

test('GET /api/system/desktop-client answers opensLinks', () => {
  assert.deepEqual(call({ desktopClientOpensLinks: () => true }, 'GET'), { status: 200, body: { opensLinks: true } });
  assert.deepEqual(call({ desktopClientOpensLinks: () => false }, 'GET').body, { opensLinks: false });
  assert.deepEqual(call({}, 'GET').body, { opensLinks: false }, 'no system service: no client');
  assert.equal(call({ desktopClientOpensLinks: () => true }, 'POST').status, 405);
  assert.equal(call({}, 'GET', '/api/system/doctor'), null);
});
