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
    json: false
  });
  assert.throws(() => parseLocalRuntimeOptions('stop', ['--open']), /Unknown stop option/);
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
