import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exerciseAdapter } from '../adapter-contract.js';
import { adapter } from './index.js';

test('antigravity: discovery, scoped writes, profiles and disconnect', async (t) => exerciseAdapter(t, adapter));

const CONTEXT = { nodePath: '/runtime/node', mcpServerPath: '/package/mcp.js', runtimeConfigPath: '/data/runtime.json' };

test('Antigravity is found by the agy CLI or by its own Gemini folders, not by Gemini CLI settings', () => {
  const home = String.raw`C:\Users\Tester`;
  const configPath = String.raw`C:\Users\Tester\.gemini\config\mcp_config.json`;
  const detect = (fileExists, commandExists = () => false) => adapter.detect({ homeDir: home, env: {}, pathApi: path.win32,
    fileExists, commandExists });
  assert.equal(detect(() => false), null);
  assert.equal(detect((file) => file === String.raw`C:\Users\Tester\.gemini\settings.json`), null);
  for (const folder of ['antigravity', 'antigravity-cli']) {
    const agent = detect((file) => file === path.win32.join(home, '.gemini', folder));
    assert.deepEqual(agent, { id: 'antigravity', label: 'Antigravity', command: 'agy', configPath, available: true }, folder);
  }
  assert.equal(detect((file) => file === configPath)?.available, true);
  assert.equal(detect(() => false, (command) => command === 'agy')?.available, true);
  assert.equal(adapter.detect({ homeDir: '/home/test', env: {}, pathApi: path.posix, fileExists: () => false,
    commandExists: () => false, includeUnavailable: true }).configPath, '/home/test/.gemini/config/mcp_config.json');
});

test('Antigravity keeps remote servers, previews in memory and runs FULI as its own source', (t) => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'fuli-antigravity-'));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const agent = adapter.detect({ homeDir, env: {}, pathApi: path, fileExists: () => false, commandExists: () => true });
  const remote = { url: 'https://mcp.example.invalid/sse' };
  mkdirSync(path.dirname(agent.configPath), { recursive: true });
  const original = JSON.stringify({ mcpServers: { remote } });
  writeFileSync(agent.configPath, original);

  const writes = [];
  const preview = adapter.connect(agent, CONTEXT, { readText: (file) => existsSync(file) ? readFileSync(file, 'utf8') : null,
    writeText: (file, text) => writes.push([file, text]) });
  assert.equal(preview.restartRequired, true);
  assert.equal(readFileSync(agent.configPath, 'utf8'), original, 'the preview wrote nothing');
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], agent.configPath);

  adapter.connect(agent, CONTEXT);
  assert.equal(readFileSync(agent.configPath, 'utf8'), writes[0][1], 'the preview showed the real write');
  const { mcpServers } = JSON.parse(readFileSync(agent.configPath, 'utf8'));
  assert.deepEqual(mcpServers.remote, remote);
  assert.deepEqual(mcpServers.fuli, { command: '/runtime/node', args: ['/package/mcp.js', '--runtime-config', '/data/runtime.json',
    '--source-application', 'antigravity', '--tool-profile', 'chat'] });
  assert.equal(adapter.disconnect(agent).status, 'disconnected');
  assert.deepEqual(JSON.parse(readFileSync(agent.configPath, 'utf8')), { mcpServers: { remote } });
});
