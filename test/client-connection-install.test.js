import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientInstaller } from '../src/system/client-connection-install.js';
import { fakeClientInstaller } from '../test-support/fake-client-installer.js';

// agent-installer is simulated in memory; nothing is written.

test('one-click connection applies a client agent-installer found and self-checks it', async () => {
  const installer = fakeClientInstaller([{ id: 'gemini' }]);
  const connect = createClientInstaller({ installer });
  for (const input of [null, {}, { clientId: 'unknown' }, { clientId: 'gemini', configPath: '/bad' }, { clientId: '__proto__' }]) {
    await assert.rejects(() => connect(input));
  }
  assert.deepEqual(installer.calls, []);
  assert.deepEqual(await connect({ clientId: 'gemini' }), { id: 'gemini', status: 'connected', restartRequired: true });
  assert.deepEqual(installer.calls, [['apply', ['gemini']]]);
});

test('the self-check reads agent-installer: a write it does not see as connected is partial', async () => {
  const connect = createClientInstaller({ installer: fakeClientInstaller([{ id: 'gemini' }], { afterApply: 'update_available' }) });
  assert.deepEqual(await connect({ clientId: 'gemini' }), { id: 'gemini', status: 'partial', restartRequired: false });
});

test('without agent-installer nothing is written and the answer says the component could not be downloaded', async () => {
  const connect = createClientInstaller({ installer: fakeClientInstaller([{ id: 'gemini' }], { unavailable: 'offline' }),
    install: () => assert.fail('no writes') });
  const result = await connect({ clientId: 'gemini' });
  assert.deepEqual({ ...result, message: undefined }, { id: 'gemini', status: 'failed', restartRequired: false,
    reason: 'client_component_unavailable', message: undefined });
  assert.match(result.message, /无法下载客户端组件.*请检查网络后重试/);
  assert.match(result.message, /could not be downloaded; check your network connection and try again/);
});

test('manual or absent clients never write, and simultaneous requests cannot overlap', async () => {
  for (const [client, clientId] of [[{ id: 'opencode', state: 'manual' }, 'opencode'], [{ id: 'gemini', detected: false }, 'gemini']]) {
    const connect = createClientInstaller({ installer: fakeClientInstaller([client]), install: () => assert.fail('no writes') });
    await assert.rejects(() => connect({ clientId }), /unavailable/);
  }
  let release;
  const connect = createClientInstaller({ installer: fakeClientInstaller([{ id: 'gemini' }]),
    install: () => new Promise((resolve) => { release = resolve; }) });
  const first = connect({ clientId: 'gemini' });
  await assert.rejects(() => connect({ clientId: 'gemini' }), /already/);
  await new Promise(setImmediate);
  release({ status: 'partial', message: '/private/config' });
  assert.deepEqual(await first, { id: 'gemini', status: 'partial', restartRequired: false });
});

test('rec#106: a client app that writes its configuration back is written only when it is known to be closed', async () => {
  for (const running of [async () => true, async () => { throw new Error('osascript timed out'); }]) {
    const installer = fakeClientInstaller([{ id: 'claude-desktop' }]);
    const connect = createClientInstaller({ installer, apps: { 'claude-desktop': { running } }, install: () => assert.fail('no writes') });
    const result = await connect({ clientId: 'claude-desktop' });
    assert.deepEqual({ ...result, message: undefined }, { id: 'claude-desktop', status: 'failed', restartRequired: false,
      reason: 'client_running', message: undefined });
    assert.match(result.message, /重启并更新/);
    assert.deepEqual(installer.calls, []);
  }
  const installer = fakeClientInstaller([{ id: 'claude-desktop' }, { id: 'gemini' }]);
  const connect = createClientInstaller({ installer, apps: { 'claude-desktop': { running: async () => false } } });
  assert.equal((await connect({ clientId: 'claude-desktop' })).status, 'connected');
  assert.equal((await connect({ clientId: 'gemini' })).status, 'connected');
  assert.deepEqual(installer.calls, [['apply', ['claude-desktop']], ['apply', ['gemini']]]);
});
