import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adapter } from './index.js';
import { inspectAgentInstallations } from '../../agent-installation-status.js';

test('codex: registry discovery and temporary configuration preserve unrelated entries', (t) => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'fuli-codex-'));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const environment = { homeDir, env: {}, platform: 'darwin', pathApi: path.posix,
    fileExists: () => true, commandExists: () => true };
  const detected = adapter.detect(environment);
  assert.equal(detected.id, 'codex');
  assert.equal(detected.available, true);
  // Exercise MCP wiring only; existing lifecycle/bootstrap tests cover their own files.
  const agent = { id: detected.id, label: detected.label, configPath: detected.configPath,
    ...('codex' === 'claude-code' ? { settingsPath: detected.settingsPath } : {}) };
  mkdirSync(path.dirname(agent.configPath), { recursive: true });
  const original = 'codex' === 'codex' ? '[mcp_servers.other]\ncommand = "other"\n' : JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } });
  writeFileSync(agent.configPath, original);
  const context = { nodePath: '/runtime/node', mcpServerPath: '/pkg/mcp.js', runtimeConfigPath: '/data/runtime.json' };
  assert.equal(adapter.connect(agent, context).status, 'connected');
  const connected = readFileSync(agent.configPath, 'utf8');
  assert.match(connected, /other/);
  assert.equal(inspectAgentInstallations([agent], context, { bootstrapCurrent: () => true })[0].integrationDetails.mcp, 'current');
  adapter.connect(agent, context);
  assert.equal(readFileSync(agent.configPath, 'utf8'), connected);
  adapter.disconnect(agent);
  const remaining = readFileSync(agent.configPath, 'utf8');
  assert.match(remaining, /other/);
  assert.doesNotMatch(remaining, /mcp_servers\.fuli|"fuli"/);
});
