import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_KIT_COMPONENTS, AGENT_KIT_PINS, agentKitAsset } from '../../src/agent-kits/pins.js';

const TARGETS = ['macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64', 'windows-x64'];

test('every component pins one released version and a SHA-256 for each published platform', () => {
  assert.deepEqual(AGENT_KIT_COMPONENTS, ['agent-session-launcher', 'agent-installer']);
  for (const [component, pin] of Object.entries(AGENT_KIT_PINS)) {
    assert.match(pin.version, /^\d+\.\d+\.\d+$/, component);
    assert.equal(pin.repository, `JevonsCode/${component}`);
    assert.deepEqual(Object.keys(pin.sha256).sort(), [...TARGETS].sort(), component);
    for (const [target, sha256] of Object.entries(pin.sha256)) assert.match(sha256, /^[a-f0-9]{64}$/, `${component} ${target}`);
    assert.equal(new Set(Object.values(pin.sha256)).size, TARGETS.length, `${component}: each platform has its own asset`);
  }
  assert.equal(Object.isFrozen(AGENT_KIT_PINS['agent-installer'].sha256), true);
});

test('a platform resolves to its release asset name, URL and checksum', () => {
  assert.deepEqual(agentKitAsset('agent-session-launcher', 'win32', 'x64'), {
    component: 'agent-session-launcher', version: '0.4.0', target: 'windows-x64',
    name: 'agent-session-launcher-windows-x64.exe',
    sha256: AGENT_KIT_PINS['agent-session-launcher'].sha256['windows-x64'],
    url: 'https://github.com/JevonsCode/agent-session-launcher/releases/download/v0.4.0/agent-session-launcher-windows-x64.exe'
  });
  assert.equal(agentKitAsset('agent-installer', 'darwin', 'arm64').url,
    'https://github.com/JevonsCode/agent-installer/releases/download/v0.3.0/agent-installer-macos-arm64');
  assert.equal(agentKitAsset('agent-installer', 'linux', 'arm64').name, 'agent-installer-linux-arm64');
  assert.equal(agentKitAsset('agent-installer', 'win32', 'arm64'), null, 'no Windows arm64 build is published');
  assert.throws(() => agentKitAsset('agent-other', 'linux', 'x64'), /Unknown agent kit component/);
});
