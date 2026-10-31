import test from 'node:test';
import assert from 'node:assert/strict';

import { runLocalRuntimeCommand } from '../src/cli/local-runtime-command.js';
import { parseLocalRuntimeOptions } from '../src/cli/local-runtime-options.js';
import { DEFAULT_CONVERSATION_LAUNCHERS } from '../src/system/runtime-settings.js';

test('local runtime options leave persisted port and LAN defaults unresolved', () => {
  assert.deepEqual(parseLocalRuntimeOptions('start', ['--open']), {
    dataDir: null,
    personalSpaceName: 'Personal',
    port: null,
    open: true,
    rebuild: false,
    lan: null,
    json: false,
    allowProviderDowngrade: false
  });
  assert.throws(() => parseLocalRuntimeOptions('stop', ['--open']), /Unknown stop option/);
  assert.equal(parseLocalRuntimeOptions('start', ['--allow-provider-downgrade']).allowProviderDowngrade, true);
  assert.throws(() => parseLocalRuntimeOptions('stop', ['--allow-provider-downgrade']), /Unknown stop option/);
  assert.equal(parseLocalRuntimeOptions('start', ['--lan']).lan, true);
  assert.equal(parseLocalRuntimeOptions('restart', ['--lan']).lan, true);
  assert.equal(parseLocalRuntimeOptions('restart', ['--no-lan']).lan, false);
  assert.throws(
    () => parseLocalRuntimeOptions('restart', ['--lan', '--no-lan']),
    /cannot be combined/
  );
  assert.throws(() => parseLocalRuntimeOptions('stop', ['--lan']), /Unknown stop option/);
});

test('fl status has a machine-readable view without secrets', async () => {
  const output = [];
  const result = await runLocalRuntimeCommand('status', ['--json'], {
    resolvePaths: () => ({ dataDir: 'C:/Fuli' }),
    inspect: async () => ({
      status: 'running',
      console: { status: 'ready', url: 'http://127.0.0.1:2727', pid: 27 },
      personal: { status: 'ready', url: 'http://127.0.0.1:8787' },
      public: { configured: false, status: 'not_connected', providers: [] }
    }),
    write: (line) => output.push(line)
  });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(output[0]).status, 'running');
});

test('fl status says whether the installed version is outdated, from what the console already knows', async () => {
  const status = async (version, consoleStatus = 'ready') => {
    const output = [];
    await runLocalRuntimeCommand('status', [], {
      resolvePaths: () => ({ dataDir: 'C:/Fuli' }),
      inspect: async () => ({
        status: consoleStatus === 'ready' ? 'running' : 'stopped',
        console: { status: consoleStatus, url: 'http://127.0.0.1:4100', pid: 27 },
        personal: { status: 'ready', url: 'http://127.0.0.1:8787' },
        public: { configured: false, status: 'not_connected', providers: [] },
        version
      }),
      write: (line) => output.push(line)
    });
    return output[0].split('\n').at(-1);
  };
  assert.equal(await status({ installed: '0.23.0', latest: '0.24.0', updateAvailable: true, checkedAt: '2026-11-01T08:00:00.000Z' }),
    'Version: 0.23.0 · v0.24.0 is available; run fuli update');
  assert.equal(await status({ installed: '0.23.0', latest: '0.23.0', updateAvailable: false, checkedAt: '2026-11-01T08:00:00.000Z' }),
    'Version: 0.23.0 (latest)');
  const unknown = { installed: '0.23.0', latest: null, updateAvailable: null, checkedAt: null };
  assert.equal(await status(unknown), 'Version: 0.23.0 (not compared with npm: the console has no answer yet)');
  assert.equal(await status(unknown, 'stopped'), 'Version: 0.23.0 (not compared with npm: the console is not running)');
});

test('fl start prints one stable local console address', async () => {
  const output = [];
  await runLocalRuntimeCommand('start', [], {
    resolvePaths: () => ({ dataDir: 'C:/Fuli' }),
    discoverAgents: () => [],
    start: async () => ({
      status: 'started',
      url: 'http://127.0.0.1:2727',
      pid: 27,
      managesDevelopmentWorkspace: false
    }),
    write: (line) => output.push(line)
  });

  assert.match(output[0], /Fuli local services started/);
  assert.match(output[0], /http:\/\/127\.0\.0\.1:2727/);
  assert.doesNotMatch(output[0], /[\p{Script=Han}]/u);
});

test('fl start says once which port it moved by itself, before the new address', async () => {
  const output = [];
  await runLocalRuntimeCommand('start', [], {
    resolvePaths: () => ({ dataDir: 'C:/Fuli' }),
    discoverAgents: () => [],
    start: async () => ({
      status: 'started',
      url: 'http://127.0.0.1:2734',
      pid: 27,
      portMoves: [{ key: 'console', from: 2727, to: 2734, reason: 'reserved' }],
      managesDevelopmentWorkspace: false
    }),
    write: (line) => output.push(line)
  });

  assert.deepEqual(output[0].split('\n').slice(0, 3), [
    'Fuli local services started.',
    'Port 2727 is reserved by Windows, so the management UI now uses port 2734. The new port is saved.',
    'Management UI: http://127.0.0.1:2734'
  ]);
});

test('fl start tells the user to run setup when an Agent integration is outdated', async () => {
  const output = [];
  const result = await runLocalRuntimeCommand('start', [], {
    resolvePaths: () => ({
      dataDir: 'C:/Fuli',
      mcpServerPath: 'C:/Package/src/mcp-server.js',
      graphRuntimeConfigPath: 'C:/Fuli/graph-runtime.json',
      sessionSkillPath: 'C:/Package/skills/capturing-session-knowledge',
      projectSkillPath: 'C:/Package/skills/grilling-project',
      reviewSkillPath: 'C:/Package/skills/flreview',
      operationSkillPath: 'C:/Package/skills/operating-fuli'
    }),
    discoverAgents: () => [{ id: 'codex', label: 'Codex', available: true }],
    inspectAgentInstallations: () => [{
      id: 'codex',
      label: 'Codex',
      integrationStatus: 'update_available',
      integrationDetails: {
        mcp: 'outdated',
        skills: 'current',
        bootstrap: 'outdated'
      }
    }],
    start: async () => ({
      status: 'started',
      url: 'http://127.0.0.1:2727',
      pid: 27
    }),
    write: (line) => output.push(line)
  });

  assert.equal(result.agentSetupCheck.status, 'checked');
  assert.match(output[0], /Agent setup required/);
  assert.match(output[0], /Codex: MCP: outdated, Bootstrap: outdated/);
  assert.match(output[0], /Run `fuli setup` to install or update them/);
});

test('fl restart applies persisted ports and LAN settings when CLI overrides are absent', async () => {
  let received = null;
  const configured = {
    version: 1,
    graphRuntimeMode: 'container',
    ports: {
      console: 3030,
      personalProvider: 18787,
      personalNeo4jHttp: 17474,
      personalNeo4jBolt: 17687,
      workspaceProvider: 18788,
      workspaceNeo4jHttp: 17475,
      workspaceNeo4jBolt: 17688
    },
    lanAccess: true,
    resourceRefreshSeconds: 10,
    conversationLaunchers: DEFAULT_CONVERSATION_LAUNCHERS,
    notifications: { needsPersonUrl: '' },
    agentNamingStyle: '',
    topicPromotion: 'auto'
  };
  await runLocalRuntimeCommand('restart', [], {
    resolvePaths: () => ({
      dataDir: 'C:/Fuli',
      runtimeSettingsPath: 'C:/Fuli/runtime-settings.json'
    }),
    readSettings(path) {
      assert.equal(path, 'C:/Fuli/runtime-settings.json');
      return configured;
    },
    restart: async (input) => {
      received = input;
      return {
        status: 'restarted',
        url: 'http://127.0.0.1:3030',
        pid: 3030,
        lan: true,
        lanUrls: ['http://192.168.31.8:3030'],
        lanAccess: { username: 'fuli', accessCode: 'temporary-access-code' }
      };
    },
    write() {}
  });

  assert.equal(received.port, 3030);
  assert.equal(received.lan, true);
  assert.deepEqual(received.runtimeSettings, configured);
});

test('fl start --lan prints protected LAN addresses and the temporary access code', async () => {
  const output = [];
  await runLocalRuntimeCommand('start', ['--lan'], {
    resolvePaths: () => ({ dataDir: 'C:/Fuli' }),
    discoverAgents: () => [],
    start: async (input) => {
      assert.equal(input.lan, true);
      return {
        status: 'started',
        url: 'http://127.0.0.1:2727',
        pid: 27,
        lan: true,
        lanUrls: ['http://192.168.31.8:2727'],
        lanAccess: { username: 'fuli', accessCode: 'temporary-access-code' },
        managesDevelopmentWorkspace: false
      };
    },
    write: (line) => output.push(line)
  });

  assert.match(output[0], /LAN URLs/);
  assert.match(output[0], /http:\/\/192\.168\.31\.8:2727/);
  assert.match(output[0], /Username: fuli/);
  assert.match(output[0], /Temporary access code: temporary-access-code/);
  assert.doesNotMatch(output[0], /[\p{Script=Han}]/u);
});
