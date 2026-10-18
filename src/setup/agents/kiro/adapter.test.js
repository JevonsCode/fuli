import { test } from 'node:test';
import { exerciseAdapter } from '../adapter-contract.js';
import { adapter } from './index.js';
test('kiro: discovery, scoped writes, profiles and disconnect', async (t) => exerciseAdapter(t, adapter));

import assert from 'node:assert/strict';
import path from 'node:path';
test('Kiro honors KIRO_HOME and discovers the CLI command', () => {
  const agent = adapter.detect({ homeDir: '/unused', env: { KIRO_HOME: '/custom/kiro' }, pathApi: path.posix,
    fileExists: () => false, commandExists: (command) => command === 'kiro-cli' });
  assert.equal(agent.configPath, '/custom/kiro/settings/mcp.json');
});
