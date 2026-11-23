import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClientPresence } from '../src/agent-kits/client-presence.js';
import { detectAgents, detectClients } from '../src/agent-kits/client-detection.js';
import { createClientConnectionObserver } from '../src/system/client-connection-status.js';
import { createClientInstaller } from '../src/system/client-connection-install.js';
import { planLocalSetup, applyLocalSetup } from '../src/setup/setup.js';
import { formatSetupPreview } from '../src/cli/setup-command.js';
import { parseSetupOptions } from '../src/setup/options.js';

const state = (component, value) => ({ component, state: value });
const installerWith = (clients) => ({ status: async () => ({ status: 'available', extensionErrors: [], clients }) });
// agent-installer found Codex only: the other two have written no configuration yet.
const NEW_COMPUTER = [
  { id: 'codex', name: 'Codex', builtin: true, detected: true, platformSupported: true, state: 'connected',
    componentStates: [state('mcp', 'current'), state('skills', 'current')] },
  { id: 'cursor', name: 'Cursor', builtin: true, detected: false, platformSupported: true, state: 'not_connected',
    componentStates: [state('mcp', 'missing'), state('skills', 'missing')] },
  { id: 'kiro', name: 'Kiro', builtin: true, detected: false, platformSupported: true, state: 'not_connected',
    componentStates: [state('mcp', 'missing')] }
];
// The commands installed on this imaginary computer, and where: 'native' here, 'wsl' only inside WSL.
const cliPresence = (installed, where = 'native') =>
  createClientPresence({ presence: { find: async (command) => (installed.includes(command) ? where : null) } });
// Every file a test writes goes into its own temporary folder, never a shared or real one.
const scratch = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-client-presence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const observerOf = (t, presence, clients = NEW_COMPUTER) => createClientConnectionObserver({
  installer: installerWith(clients), customClients: { removable: () => new Set() },
  historyPath: join(scratch(t), 'history.json'), homeDir: scratch(t), presence });

test('a client installed here but with no configuration yet still counts as on this computer', async () => {
  const presence = cliPresence(['cursor-agent']);
  assert.deepEqual(await presence.find(['cursor', 'kiro', 'opencode']), { installed: new Set(['cursor']), inWsl: new Set() });
  const answer = await detectClients(installerWith(NEW_COMPUTER), { presence });
  assert.deepEqual(answer.clients.map(({ id, detected }) => [id, detected]),
    [['codex', true], ['cursor', true], ['kiro', false]]);
  // Without the presence port nothing changes: agent-installer's answer stands.
  const plain = await detectClients(installerWith(NEW_COMPUTER));
  assert.deepEqual(plain.clients.map(({ id, detected }) => [id, detected]),
    [['codex', true], ['cursor', false], ['kiro', false]]);
});

test('a client that is not on this computer is never asked about twice, and a connected one is not asked at all', async () => {
  const asked = [];
  const presence = createClientPresence({ presence: { find: async (command) => { asked.push(command); return null; } } });
  await detectClients(installerWith(NEW_COMPUTER), { presence });
  // Codex was found already; Kiro has no command of its own in the table.
  assert.deepEqual(asked, ['cursor-agent', 'cursor']);
});

test('setup connects a client whose CLI is here, and names the ones that are not', async (t) => {
  const presence = cliPresence(['cursor-agent']);
  const plan = await planLocalSetup(parseSetupOptions(['--yes']), {
    resolvePaths: () => ({ dataDir: scratch(t), runtimeSettingsPath: null, adaptiveRuntimeSettingsPath: null }),
    detect: () => detectAgents(installerWith(NEW_COMPUTER), { presence }),
    settingsExist: () => true
  });
  assert.deepEqual(plan.agents.map(({ id, available }) => [id, available]),
    [['codex', true], ['cursor', true], ['kiro', false]]);
  const written = [];
  const result = await applyLocalSetup(plan, parseSetupOptions(['--yes']), {
    ensureRuntime: async () => ({ status: 'ready', url: null }),
    clientInstaller: {
      apply: async (ids) => {
        written.push(...ids);
        return { status: 'available', clients: ids.map((id) => ({ id, changes: [], problems: [], actions: [], actionCodes: [] })) };
      },
      // The self-check reads the clients back after the write.
      status: async () => ({ status: 'available', extensionErrors: [],
        clients: NEW_COMPUTER.map((client) => (written.includes(client.id)
          ? { ...client, detected: true, state: 'connected',
            componentStates: client.componentStates.map(({ component }) => state(component, 'current')) }
          : client)) }) },
    beginFirstRun: () => {},
    reconcileKnowledge: null,
    keepDataDirectoryPrivate: async () => true
  });
  // Cursor's configuration file does not exist yet; agent-installer creates it.
  assert.deepEqual(written, ['codex', 'cursor']);
  assert.deepEqual(result.agents.map(({ id, status }) => [id, status]), [['codex', 'connected'], ['cursor', 'connected']]);
  const preview = formatSetupPreview(plan, parseSetupOptions(['--yes']));
  assert.match(preview, /Automatic client setup: Codex, Cursor/);
  assert.match(preview, /Not on this computer: Kiro/);
});

test('the console tells "installed but not connected" from "not installed", and never waits for a shell to say so', async (t) => {
  let release;
  const shell = new Promise((resolve) => { release = resolve; });
  const presence = createClientPresence({ presence: { find: async (command) => { await shell; return command === 'cursor-agent' ? 'native' : null; } } });
  const observer = observerOf(t, presence);
  // The first read answers at once from what is known (nothing yet) and starts the probe.
  const first = await observer.observe();
  assert.deepEqual(first.clients.map(({ id, status }) => [id, status]),
    [['codex', 'connected'], ['cursor', 'not_detected'], ['kiro', 'not_detected']]);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  // The next read shows what the probe found.
  const next = await observer.observe();
  assert.deepEqual(next.clients.map(({ id, status }) => [id, status]),
    [['codex', 'connected'], ['cursor', 'not_connected'], ['kiro', 'not_detected']]);
});

test('a client only inside WSL is not on this Windows computer for FULI: never written, and said apart', async (t) => {
  const presence = cliPresence(['cursor-agent'], 'wsl');
  const answer = await detectClients(installerWith(NEW_COMPUTER), { presence });
  const cursor = answer.clients.find(({ id }) => id === 'cursor');
  assert.deepEqual([cursor.detected, cursor.inWsl], [false, true]);
  // One-click connect refuses it: writing it under %USERPROFILE% would connect nothing.
  const connect = createClientInstaller({ installer: installerWith(NEW_COMPUTER), presence,
    install: async () => assert.fail('a WSL-only client must not be written') });
  await assert.rejects(() => connect({ clientId: 'cursor' }), /unavailable for automatic connection/);
  // Setup does not connect it and says where it is instead.
  const plan = await planLocalSetup(parseSetupOptions(['--yes']), {
    resolvePaths: () => ({ dataDir: scratch(t), runtimeSettingsPath: null, adaptiveRuntimeSettingsPath: null }),
    detect: () => detectAgents(installerWith(NEW_COMPUTER), { presence }), settingsExist: () => true });
  assert.deepEqual(plan.agents.find(({ id }) => id === 'cursor'), { id: 'cursor', label: 'Cursor', available: false, inWsl: true,
    integrationStatus: 'not_connected', integrationDetails: { mcp: 'missing', skills: 'missing' } });
  const preview = formatSetupPreview(plan, parseSetupOptions(['--yes']));
  assert.match(preview, /Not on this computer: Kiro$/m);
  assert.match(preview, /Installed only inside WSL, so FULI on this Windows cannot connect it: Cursor\. Run fuli setup inside WSL/);
  // The console's tile carries it, waiting for the probe like any other.
  const observer = observerOf(t, presence);
  await observer.observe();
  await new Promise((resolve) => setImmediate(resolve));
  const tile = (await observer.observe()).clients.find(({ id }) => id === 'cursor');
  assert.deepEqual([tile.status, tile.inWsl], ['not_detected', true]);
});

test('DeepSeek Harness is never taken for installed from a command named dsh alone', async () => {
  const asked = [];
  const presence = createClientPresence({ presence: { find: async (command) => { asked.push(command); return 'native'; } } });
  const found = await presence.find(['dsh', 'cursor']);
  assert.deepEqual([...found.installed], ['cursor']);
  assert.equal(asked.includes('dsh'), false);
});

test('one-click connect writes a client whose CLI is here, and refuses one that is not installed', async () => {
  const applied = [];
  const connect = createClientInstaller({ installer: installerWith(NEW_COMPUTER), presence: cliPresence(['cursor-agent']),
    install: async (_installer, agent) => { applied.push(agent.id); return { status: 'connected' }; } });
  assert.deepEqual(await connect({ clientId: 'cursor' }), { id: 'cursor', status: 'connected', restartRequired: true });
  await assert.rejects(() => connect({ clientId: 'kiro' }), /unavailable for automatic connection/);
  assert.deepEqual(applied, ['cursor']);
});
