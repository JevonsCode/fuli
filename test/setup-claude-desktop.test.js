import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverAgents } from '../src/setup/agents.js';
import { inspectAgentInstallations } from '../src/setup/agent-installation-status.js';
import { connectClaudeDesktop, disconnectClaudeDesktop } from '../src/setup/claude-desktop-config.js';
import { stablePackageRoot } from '../src/setup/stable-package-root.js';

const context = { nodePath: 'C:\\nvm4w\\nodejs\\node.exe', mcpServerPath: 'C:\\nvm4w\\nodejs\\node_modules\\fuli-context\\src\\mcp-server.js', runtimeConfigPath: 'C:\\Fuli\\graph-runtime.json' };

test('Claude Desktop is discovered from its app data folder on Windows and macOS only', () => {
  const desktop = (platform, env, exists) => discoverAgents({ platform, env, homeDir: platform === 'win32' ? 'C:\\Users\\me' : '/Users/me',
    fileExists: exists, commandExists: () => false }).find(({ id }) => id === 'claude-desktop');
  const windows = desktop('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, (path) => path === 'C:\\Users\\me\\AppData\\Roaming\\Claude');
  assert.equal(windows.configPath, 'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
  assert.equal(windows.available, true);
  assert.equal(windows.skillPath, undefined);
  assert.equal(desktop('darwin', {}, () => false).configPath, '/Users/me/Library/Application Support/Claude/claude_desktop_config.json');
  assert.equal(desktop('linux', {}, () => true), undefined);
});

test('setup registers the chat profile as Claude and keeps the rest of the config', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-claude-desktop-'));
  const agent = { id: 'claude-desktop', label: 'Claude Desktop', configPath: join(directory, 'claude_desktop_config.json') };
  writeFileSync(agent.configPath, JSON.stringify({ preferences: { sidebarMode: 'epitaxy' }, mcpServers: { other: { command: 'x' } } }));
  const first = connectClaudeDesktop(agent, context);
  assert.equal(first.restartRequired, true);
  const written = JSON.parse(readFileSync(agent.configPath, 'utf8'));
  assert.deepEqual(written.preferences, { sidebarMode: 'epitaxy' });
  assert.deepEqual(written.mcpServers.other, { command: 'x' });
  assert.deepEqual(written.mcpServers.fuli.args.slice(3), ['--source-application', 'claude', '--tool-profile', 'chat']);
  assert.equal(connectClaudeDesktop(agent, context).restartRequired, false);

  const [status] = inspectAgentInstallations([agent], { ...context, sessionSkillPath: '/skills/a', projectSkillPath: '/skills/b',
    reviewSkillPath: '/skills/c', operationSkillPath: '/skills/d' });
  assert.equal(status.integrationStatus, 'connected');
  assert.equal(status.integrationDetails.mcp, 'current');

  assert.equal(disconnectClaudeDesktop(agent).status, 'disconnected');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(agent.configPath, 'utf8')).mcpServers), ['other']);
});

test('client configs use the active Node symlink instead of a versioned folder', () => {
  const real = 'C:\\Users\\me\\AppData\\Local\\nvm\\v24.18.0\\node_modules\\fuli-context';
  const linked = 'C:\\nvm4w\\nodejs\\node_modules\\fuli-context';
  const realpath = (path) => path.replace('C:\\nvm4w\\nodejs', 'C:\\Users\\me\\AppData\\Local\\nvm\\v24.18.0');
  const options = { execPath: 'C:\\nvm4w\\nodejs\\node.exe', realpath, exists: (path) => path === linked || path === real };
  if (process.platform === 'win32') assert.equal(stablePackageRoot(real, options), linked);
  assert.equal(stablePackageRoot('/repo/fuli', { execPath: '/usr/bin/node', realpath: (path) => path, exists: () => false }), '/repo/fuli');
  assert.equal(stablePackageRoot(real, { ...options, realpath: () => { throw new Error('gone'); } }), real);
});
