import { test } from 'node:test';
import { exerciseAdapter } from '../adapter-contract.js';
import { adapter } from './index.js';
test('kiro: target, scoped writes, profiles and disconnect', async (t) => exerciseAdapter(t, adapter));

import assert from 'node:assert/strict';
import path from 'node:path';
test('Kiro honors KIRO_HOME', () => {
  const agent = adapter.target({ homeDir: '/unused', env: { KIRO_HOME: '/custom/kiro' }, pathApi: path.posix });
  assert.equal(agent.configPath, '/custom/kiro/settings/mcp.json');
});
