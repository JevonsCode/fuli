// Shared fixture for MCP-only adapter contract tests; all writes stay in a temp home.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function exerciseAdapter(t, adapter) {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'fuli-adapter-'));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const environment = { homeDir, env: {}, platform: process.platform, pathApi: path,
    fileExists: () => false, commandExists: () => false };
  assert.equal(adapter.detect(environment), null);
  const agent = adapter.detect({ ...environment, commandExists: () => true });
  assert.equal(agent.available, true);
  assert.ok(agent.configPath.startsWith(homeDir));
  const config = adapter.id === 'opencode' ? { theme: 'dark', mcp: { other: { type: 'local', command: ['other'] } } }
    : { theme: 'dark', mcpServers: { other: { command: 'other' } } };
  mkdirSync(path.dirname(agent.configPath), { recursive: true });
  writeFileSync(agent.configPath, JSON.stringify(config));
  const context = { nodePath: '/runtime/node', mcpServerPath: '/package/mcp.js', runtimeConfigPath: '/data/runtime.json' };
  assert.equal(adapter.connect(agent, context).status, 'connected');
  const first = readFileSync(agent.configPath, 'utf8');
  const connected = JSON.parse(first);
  const servers = connected.mcp ?? connected.mcpServers;
  assert.equal(connected.theme, 'dark');
  assert.deepEqual(servers.other, (config.mcp ?? config.mcpServers).other);
  const args = servers.fuli.args ?? servers.fuli.command;
  assert.equal(args[args.indexOf('--tool-profile') + 1], 'chat');
  assert.equal(adapter.status(agent, context).registration.current, true);
  const modified = statSync(agent.configPath).mtimeMs;
  adapter.connect(agent, context);
  assert.equal(readFileSync(agent.configPath, 'utf8'), first);
  assert.equal(statSync(agent.configPath).mtimeMs, modified);
  args[args.indexOf('--tool-profile') + 1] = 'full';
  writeFileSync(agent.configPath, JSON.stringify(connected));
  adapter.connect(agent, context);
  assert.match(readFileSync(agent.configPath, 'utf8'), /"full"/);
  adapter.disconnect(agent);
  assert.deepEqual(JSON.parse(readFileSync(agent.configPath, 'utf8')), config);
  adapter.disconnect(agent);
  assert.deepEqual(JSON.parse(readFileSync(agent.configPath, 'utf8')), config);
  for (const malformed of ['{broken', '[]', '{"mcpServers":[],"mcp":[]}']) {
    writeFileSync(agent.configPath, malformed);
    assert.throws(() => adapter.connect(agent, context));
    assert.equal(readFileSync(agent.configPath, 'utf8'), malformed);
  }
}
