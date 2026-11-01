import { test } from 'node:test';
import { exerciseAdapter } from '../adapter-contract.js';
import { adapter } from './index.js';
test('qwen-code: target, scoped writes, profiles and disconnect', async (t) => exerciseAdapter(t, adapter));

import assert from 'node:assert/strict';
import path from 'node:path';
test('Qwen honors absolute, relative and tilde QWEN_HOME directories', () => {
  const environment = { homeDir: '/home/test', cwd: '/workspace', pathApi: path.posix,
    fileExists: () => false };
  for (const [override, expected] of [['/custom/qwen', '/custom/qwen/settings.json'], ['relative', '/workspace/relative/settings.json'], ['~/custom', '/home/test/custom/settings.json'], ['', '/home/test/.qwen/settings.json']]) {
    assert.equal(adapter.target({ ...environment, env: { QWEN_HOME: override } }).configPath, expected);
  }
});
