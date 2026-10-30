import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { agentKitExecutables } from '../../src/agent-kits/executables.js';
import { launcherHostConfig } from '../../src/agent-kits/launcher-host-config.js';
import { sessionClientRecords } from '../../src/agent-kits/session-clients.js';
import { createSessionLauncherPort } from '../../src/agent-kits/session-launcher.js';
import { createSessionOffers } from '../../src/agent-kits/session-offers.js';
import { recordClaudeSessionClient } from '../../src/agents/claude-code/session-client.js';
import { DEFAULT_CONVERSATION_LAUNCHERS, normalizeConversationLaunchers } from '../../src/system/runtime-settings.js';
import { isolateHomeEnvironment, realAgentKitExecutable } from '../../test-support/agent-kit-binaries.js';

const THREAD = '123e4567-e89b-42d3-a456-426614174000';

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-session-launcher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Synthetic settings: the default Codex link, a Cursor link the launcher can
// express, a Kiro link it cannot (a web scheme) and a disabled Claude Code link.
const LAUNCHERS = normalizeConversationLaunchers({
  cursor: { enabled: true, idFormat: 'any', appName: 'Cursor', urlTemplate: 'cursor://open/session?id={id}' },
  kiro: { enabled: true, idFormat: 'any', appName: 'Kiro', urlTemplate: 'https://example.invalid/kiro/{id}' },
  claude_code: { enabled: false, idFormat: 'any', appName: 'Claude Code', urlTemplate: 'synthetic-claude://sessions/{id}' }
});

test('the host configuration is generated from conversationLaunchers', () => {
  assert.deepEqual(launcherHostConfig(DEFAULT_CONVERSATION_LAUNCHERS), {
    config: { schemaVersion: 1, clients: { 'fuli-codex': { name: 'Codex', enabled: true,
      launch: { uri: 'codex://threads/{id}', idFormat: 'uuid' } } } },
    hostClients: { codex: 'fuli-codex' }
  });
  const { config, hostClients } = launcherHostConfig(LAUNCHERS);
  assert.deepEqual(hostClients, { codex: 'fuli-codex', claude_code: 'fuli-claude-code', cursor: 'fuli-cursor' },
    'a web link stays with FULI\'s own rules; an empty template has nothing to express');
  assert.deepEqual(config.clients['fuli-claude-code'], { name: 'Claude Code', enabled: false,
    launch: { uri: 'synthetic-claude://sessions/{id}', idFormat: 'safe' } });
  assert.deepEqual(config.clients['fuli-cursor'].launch, { uri: 'cursor://open/session?id={id}', idFormat: 'safe' });
  for (const urlTemplate of ['codex://threads/x{id}', 'codex:threads/{id}', 'codex://threads/{id}#top', 'Codex://threads/{id}']) {
    assert.deepEqual(launcherHostConfig({ codex: { enabled: true, idFormat: 'uuid', appName: 'Codex', urlTemplate } }).hostClients, {},
      urlTemplate);
  }
});

function harness(root, executable) {
  const configPath = join(root, 'data', 'agent-kits', 'launcher.json');
  const executables = agentKitExecutables({ nativeRuntimeDir: join(root, 'data', 'native-runtime'),
    env: executable ? { FULI_AGENT_SESSION_LAUNCHER: executable } : {} });
  const launcher = createSessionLauncherPort({ executables, configPath, extensionsDir: join(root, 'extensions') });
  const records = sessionClientRecords(join(root, 'data'));
  return { configPath, launcher, records,
    offers: createSessionOffers({ launcher, configPath, records, readLaunchers: () => LAUNCHERS }) };
}

test('without a launcher the console keeps its own link rules', async (t) => {
  const root = directory(t);
  // An override that names nothing: unavailable, and never a download instead.
  const { offers, configPath } = harness(root, join(root, 'missing.exe'));
  assert.deepEqual(await offers.offers([{ sourceApplication: 'codex', sessionId: THREAD }]), { launcher: 'unavailable',
    reason: 'FULI_AGENT_SESSION_LAUNCHER does not name an executable file.' });
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).clients['fuli-codex'].enabled, true,
    'the host configuration is written even before a launcher exists');
});

test('the real launcher decides which recorded sessions get a link', async (t) => {
  const executable = await realAgentKitExecutable('agent-session-launcher');
  if (!executable) { t.skip('the pinned launcher cannot be downloaded here'); return; }
  isolateHomeEnvironment(t);
  const root = directory(t);
  mkdirSync(join(root, 'extensions'));
  const { offers, records, launcher } = harness(root, executable);
  // What Claude Code's hooks left: the raw entry point, no client yet.
  const runtimeConfigPath = join(root, 'data', 'graph-runtime.json');
  recordClaudeSessionClient({ runtimeConfigPath, sessionId: 'desktop-session', env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } });
  recordClaudeSessionClient({ runtimeConfigPath, sessionId: 'terminal-session', env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  records.record('claude_code', 'classified-earlier', { client: 'claude-desktop', source: 'Claude Code', entrypoint: 'claude-desktop' });

  const answer = await offers.offers([
    { sourceApplication: 'codex', sessionId: THREAD },
    { sourceApplication: 'codex', sessionId: 'not-a-thread-id' },
    { sourceApplication: 'cursor', sessionId: 'cursor-session-7' },
    { sourceApplication: 'kiro', sessionId: 'kiro-session' },
    { sourceApplication: 'claude_code', sessionId: 'desktop-session' },
    { sourceApplication: 'claude_code', sessionId: 'terminal-session' },
    { sourceApplication: 'claude_code', sessionId: 'classified-earlier' },
    { sourceApplication: 'claude_code', sessionId: 'recorded-before-the-launcher' },
    { sourceApplication: 'opencode', sessionId: 'ses_synthetic' }
  ]);
  assert.equal(answer.launcher, 'available');
  assert.deepEqual(answer.offers.map(({ sessionId, client, offer, href }) => [sessionId, client, offer, href]), [
    [THREAD, 'codex', 'link', `codex://threads/${THREAD}`],
    ['not-a-thread-id', 'codex', 'none', undefined],
    ['cursor-session-7', 'cursor', 'link', 'cursor://open/session?id=cursor-session-7'],
    ['kiro-session', 'unknown', 'fuli', undefined],
    ['desktop-session', 'claude-desktop', 'none', undefined],
    ['terminal-session', 'claude-code', 'none', undefined],
    ['classified-earlier', 'claude-desktop', 'none', undefined],
    ['recorded-before-the-launcher', 'claude-code-unknown', 'none', undefined],
    ['ses_synthetic', 'opencode', 'fuli', undefined]
  ]);
  // The console's answers are kept with the hook's records; an old session gets no record.
  assert.deepEqual(records.read('claude_code', 'desktop-session'),
    { client: 'claude-desktop', source: 'Claude Code', entrypoint: 'claude-desktop' });
  assert.deepEqual(records.read('claude_code', 'terminal-session'), { client: 'claude-code', source: 'Claude Code CLI', entrypoint: 'cli' });
  assert.equal(records.read('claude_code', 'recorded-before-the-launcher'), null);
  assert.deepEqual((await launcher.clients()).clients.filter(({ origin }) => origin === 'host')
    .map(({ id, enabled, kind }) => [id, enabled, kind]),
  [['fuli-codex', true, 'uri'], ['fuli-claude-code', false, 'uri'], ['fuli-cursor', true, 'uri']]);
});

test('a host configuration the launcher refuses falls back instead of failing', async (t) => {
  const executable = await realAgentKitExecutable('agent-session-launcher');
  if (!executable) { t.skip('the pinned launcher cannot be downloaded here'); return; }
  isolateHomeEnvironment(t);
  const root = directory(t);
  const { launcher, configPath } = harness(root, executable);
  mkdirSync(join(root, 'data', 'agent-kits'), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, clients: { codex: { launch: { uri: 'codex://x/{id}' } } } }));
  const answer = await launcher.classify('Codex');
  assert.equal(answer.status, 'unavailable');
  assert.match(answer.reason, /^invalid_configuration: /);
  assert.deepEqual(await launcher.inspect({ client: 'not-a-client' }).then(({ status }) => status), 'unavailable');
});

test('reading and saving the settings regenerate the launcher host configuration', async (t) => {
  const { createSystemService } = await import('../../src/system/system-service.js');
  const { DEFAULT_RUNTIME_SETTINGS } = await import('../../src/system/runtime-settings.js');
  const root = directory(t);
  const paths = { dataDir: root, runtimeSettingsPath: join(root, 'runtime-settings.json'),
    graphRuntimeStatePath: join(root, 'graph-runtime-state.json'), graphRuntimeConfigPath: join(root, 'graph-runtime.json'),
    launcherHostConfigPath: join(root, 'agent-kits', 'launcher.json'), installerManifestPath: join(root, 'agent-kits', 'fuli-installer.json'),
    nativeRuntimeDir: join(root, 'native-runtime') };
  const system = createSystemService({ paths, packageRoot: '.', settingsApplier: { status: () => null }, resourceMonitor: {},
    runtimeBroker: {}, clientObserver: { observe: () => ({ clients: [] }) } });
  const hostClients = () => Object.keys(JSON.parse(readFileSync(paths.launcherHostConfigPath, 'utf8')).clients);
  system.getSettings();
  assert.deepEqual(hostClients(), ['fuli-codex']);
  await system.updateSettings({ ...structuredClone(DEFAULT_RUNTIME_SETTINGS), conversationLaunchers: LAUNCHERS });
  assert.deepEqual(hostClients(), ['fuli-codex', 'fuli-claude-code', 'fuli-cursor']);
});
