import { test } from 'node:test';
import { exerciseAdapter } from '../adapter-contract.js';
import { adapter } from './index.js';
test('opencode: discovery, scoped writes, profiles and disconnect', async (t) => exerciseAdapter(t, adapter));

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('OpenCode keeps JSONC comments and offers manual setup for layered global overrides', (t) => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'fuli-opencode-'));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const configPath = path.join(homeDir, '.config/opencode/opencode.jsonc');
  mkdirSync(path.dirname(configPath), { recursive: true });
  const raw = '{\n // user theme\n "theme":"dark",\n "mcp": {"other":{"type":"local","command":["other"]}},\n}';
  writeFileSync(configPath, raw);
  const environment = { homeDir, pathApi: path.posix, env: {}, commandExists: () => false,
    fileExists: (file) => file === configPath };
  const agent = adapter.detect(environment);
  assert.equal(agent.configPath, configPath);
  adapter.connect(agent, { nodePath: 'node', mcpServerPath: 'mcp.js', runtimeConfigPath: 'runtime.json' });
  assert.ok(readFileSync(configPath, 'utf8').includes('// user theme'));
  adapter.disconnect(agent);
  assert.ok(readFileSync(configPath, 'utf8').includes('// user theme'));
  const manual = adapter.detect({ ...environment, env: { OPENCODE_CONFIG: '/custom/config' } });
  assert.equal(manual.manualOnly, true);
  assert.throws(() => adapter.connect(manual, {}), /manual/);
  assert.equal(adapter.detect({ ...environment, fileExists: () => true }).manualOnly, true);
});
