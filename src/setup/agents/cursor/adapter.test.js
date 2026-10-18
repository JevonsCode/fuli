import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adapter } from './index.js';
import { inspectAgentInstallations } from '../../agent-installation-status.js';

test('cursor: registry discovery and temporary configuration preserve unrelated entries', (t) => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'fuli-cursor-'));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const environment = { homeDir, env: {}, platform: 'darwin', pathApi: path.posix,
    fileExists: () => true, commandExists: () => true };
  const detected = adapter.detect(environment);
  assert.equal(detected.id, 'cursor');
  assert.equal(detected.available, true);
  // Exercise MCP wiring only; existing lifecycle/bootstrap tests cover their own files.
  const agent = { id: detected.id, label: detected.label, configPath: detected.configPath,
    ...('cursor' === 'claude-code' ? { settingsPath: detected.settingsPath } : {}) };
  mkdirSync(path.dirname(agent.configPath), { recursive: true });
  const original = 'cursor' === 'codex' ? '[mcp_servers.other]\ncommand = "other"\n' : JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } });
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

test('one-click Cursor defaults chat and retains an existing explicit full profile', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'fuli-cursor-profile-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = { id: 'cursor', label: 'Cursor', configPath: path.join(home, 'mcp.json') };
  const context = { nodePath: 'node', mcpServerPath: 'mcp.js', runtimeConfigPath: 'runtime.json', defaultToolProfile: 'chat' };
  adapter.connect(agent, context);
  let config = JSON.parse(readFileSync(agent.configPath, 'utf8'));
  const args = config.mcpServers.fuli.args;
  assert.equal(args.at(-1), 'chat');
  args[args.indexOf('--tool-profile') + 1] = 'full';
  writeFileSync(agent.configPath, JSON.stringify(config));
  adapter.connect(agent, context);
  config = JSON.parse(readFileSync(agent.configPath, 'utf8'));
  assert.equal(config.mcpServers.fuli.args.at(-1), 'full');
});
