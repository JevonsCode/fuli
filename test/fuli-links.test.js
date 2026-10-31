import assert from 'node:assert/strict';
import test from 'node:test';

import { FULI_LINK_ORIGIN, fuliLinkOrigin } from '../src/desktop/fuli-links.js';
import { agentProfileUrl, captureSettingsUrl } from '../src/agents/identity-receipt.js';

const INSTALL_ROOT = 'C:\\Users\\synthetic\\AppData\\Local\\Programs\\Fuli';
const LAUNCHER = `"${INSTALL_ROOT}\\versions\\00000000-0000-4000-8000-000000000001\\Fuli.exe" "%1"`;
const installed = () => ({ installRoot: INSTALL_ROOT });

test('receipt links stay http off Windows and outside an installed copy', () => {
  assert.equal(fuliLinkOrigin({ platform: 'darwin', readCommand: () => LAUNCHER })(), null);
  assert.equal(fuliLinkOrigin({ platform: 'win32', readInstallation: () => null, readCommand: () => LAUNCHER })(), null);
  assert.equal(fuliLinkOrigin({ platform: 'win32', readInstallation: () => { throw new Error('moved'); },
    readCommand: () => LAUNCHER })(), null);
});

test('receipt links become fuli:// only while the scheme opens this installation', () => {
  const origin = (command) => fuliLinkOrigin({ platform: 'win32', readInstallation: installed, readCommand: () => command })();
  assert.equal(origin(LAUNCHER), FULI_LINK_ORIGIN);
  assert.equal(origin(null), null, 'no scheme registered: the client never ran');
  assert.equal(origin('"C:\\Users\\synthetic\\Other\\Fuli.exe" "%1"'), null, 'another installation');
  assert.equal(origin(`"${INSTALL_ROOT}\\versions\\x\\client\\FULI.exe" "%1"`), null, 'not the launcher');
});

test('the scheme is read at most once a minute', () => {
  let reads = 0;
  let clock = 0;
  const origin = fuliLinkOrigin({ platform: 'win32', readInstallation: installed, now: () => clock,
    readCommand: () => { reads += 1; return reads === 1 ? null : LAUNCHER; } });
  assert.equal(origin(), null);
  clock = 59_000;
  assert.equal(origin(), null);
  clock = 60_000;
  assert.equal(origin(), FULI_LINK_ORIGIN, 'a client registered since the last read');
  assert.equal(reads, 2);
});

test('receipt pages read as the fuli:// links the desktop client opens', () => {
  const application = { fuliLinkOrigin: () => FULI_LINK_ORIGIN, consoleUrl: 'http://127.0.0.1:3999',
    config: { personal: { spaceId: 'synthetic-space' } } };
  assert.equal(captureSettingsUrl(application), 'fuli://settings');
  assert.equal(agentProfileUrl(application, 'agent-1'), 'fuli://agents/synthetic-space/agent-1');
  assert.equal(captureSettingsUrl({ ...application, fuliLinkOrigin: () => null }), 'http://127.0.0.1:3999/settings');
});
