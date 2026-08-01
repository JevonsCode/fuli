import test from 'node:test';
import assert from 'node:assert/strict';

import { runLocalRuntimeCommand } from '../src/cli/local-runtime-command.js';
import { parseLocalRuntimeOptions } from '../src/cli/local-runtime-options.js';

test('local runtime options use port 2727 and support an explicit browser open', () => {
  assert.deepEqual(parseLocalRuntimeOptions('start', ['--open']), {
    dataDir: null,
    personalSpaceName: '我',
    port: 2727,
    open: true,
    rebuild: false,
    lan: false,
    json: false
  });
  assert.throws(() => parseLocalRuntimeOptions('stop', ['--open']), /Unknown stop option/);
  assert.equal(parseLocalRuntimeOptions('start', ['--lan']).lan, true);
  assert.equal(parseLocalRuntimeOptions('restart', ['--lan']).lan, true);
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

  assert.match(output[0], /Fuli 本地服务已启动/);
  assert.match(output[0], /http:\/\/127\.0\.0\.1:2727/);
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

  assert.match(output[0], /局域网界面/);
  assert.match(output[0], /http:\/\/192\.168\.31\.8:2727/);
  assert.match(output[0], /访问用户名：fuli/);
  assert.match(output[0], /临时访问口令：temporary-access-code/);
});
