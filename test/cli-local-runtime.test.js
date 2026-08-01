import test from 'node:test';
import assert from 'node:assert/strict';

import { runLocalRuntimeCommand } from '../src/cli/local-runtime-command.js';
import { parseLocalRuntimeOptions } from '../src/cli/local-runtime-options.js';

test('local runtime options leave persisted port and LAN defaults unresolved', () => {
  assert.deepEqual(parseLocalRuntimeOptions('start', ['--open']), {
    dataDir: null,
    personalSpaceName: 'Personal',
    port: null,
    open: true,
    rebuild: false,
    lan: null,
    json: false
  });
  assert.throws(() => parseLocalRuntimeOptions('stop', ['--open']), /Unknown stop option/);
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

test('fl start prints one stable local console address', async () => {
  const output = [];
  await runLocalRuntimeCommand('start', [], {
    resolvePaths: () => ({ dataDir: 'C:/Fuli' }),
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

test('fl restart applies persisted ports and LAN settings when CLI overrides are absent', async () => {
  let received = null;
  const configured = {
    version: 1,
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
    resourceRefreshSeconds: 10
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
