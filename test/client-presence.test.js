import assert from 'node:assert/strict';
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
// Only Cursor's own CLI is installed on this imaginary computer.
const cliPresence = (installed) => createClientPresence({ presence: { find: async (command) => (installed.includes(command) ? 'native' : null) } });

test('a client installed here but with no configuration yet still counts as on this computer', async () => {
  const presence = cliPresence(['cursor-agent']);
  assert.deepEqual(await presence.installed(['cursor', 'kiro', 'opencode']), new Set(['cursor']));
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

test('setup connects a client whose CLI is here, and names the ones that are not', async () => {
  const presence = cliPresence(['cursor-agent']);
  const plan = await planLocalSetup(parseSetupOptions(['--yes']), {
    resolvePaths: () => ({ dataDir: '/tmp/none', runtimeSettingsPath: null, adaptiveRuntimeSettingsPath: null }),
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

test('the console tells "installed but not connected" from "not installed", and counts both', async () => {
  const observer = createClientConnectionObserver({
    installer: installerWith(NEW_COMPUTER),
    customClients: { removable: () => new Set() },
    historyPath: '/tmp/fuli-test-does-not-exist/history.json',
    presence: cliPresence(['cursor-agent'])
  });
  const observation = await observer.observe();
  assert.deepEqual(observation.clients.map(({ id, status }) => [id, status]),
    [['codex', 'connected'], ['cursor', 'not_connected'], ['kiro', 'not_detected']]);
});

test('one-click connect writes a client whose CLI is here, and refuses one that is not installed', async () => {
  const applied = [];
  const connect = createClientInstaller({ installer: installerWith(NEW_COMPUTER), presence: cliPresence(['cursor-agent']),
    install: async (_installer, agent) => { applied.push(agent.id); return { status: 'connected' }; } });
  assert.deepEqual(await connect({ clientId: 'cursor' }), { id: 'cursor', status: 'connected', restartRequired: true });
  await assert.rejects(() => connect({ clientId: 'kiro' }), /unavailable for automatic connection/);
  assert.deepEqual(applied, ['cursor']);
});
