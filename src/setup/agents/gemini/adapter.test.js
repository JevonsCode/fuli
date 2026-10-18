import { test } from 'node:test';
import { exerciseAdapter } from '../adapter-contract.js';
import { adapter } from './index.js';
test('gemini: discovery, scoped writes, profiles and disconnect', async (t) => exerciseAdapter(t, adapter));

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
test('Gemini custom home and old HTTP transport cannot shadow the new stdio connection', (t) => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'fuli-gemini-'));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const agent = adapter.detect({ homeDir: path.join(homeDir, 'unused'), env: { GEMINI_CLI_HOME: homeDir }, pathApi: path,
    commandExists: () => true, fileExists: () => false });
  assert.equal(agent.configPath, path.join(homeDir, '.gemini/settings.json'));
  mkdirSync(path.dirname(agent.configPath), { recursive: true });
  writeFileSync(agent.configPath, JSON.stringify({ mcpServers: { fuli: { httpUrl: 'https://old.invalid', url: 'https://old.invalid', env: { LOCAL_SETTING: 'retained' } } } }));
  adapter.connect(agent, { nodePath: 'node', mcpServerPath: 'mcp.js', runtimeConfigPath: 'runtime.json' });
  const server = JSON.parse(readFileSync(agent.configPath, 'utf8')).mcpServers.fuli;
  assert.equal(server.httpUrl, undefined);
  assert.equal(server.url, undefined);
  assert.deepEqual(server.env, { LOCAL_SETTING: 'retained' });
});

test('Gemini discovers a Windows custom home without accessing the host filesystem', () => {
  const configPath = String.raw`C:\Users\Tester\Gemini Home\.gemini\settings.json`;
  const agent = adapter.detect({ homeDir: String.raw`C:\Users\Tester`, cwd: String.raw`C:\workspace`,
    env: { GEMINI_CLI_HOME: String.raw`C:\Users\Tester\Gemini Home` }, pathApi: path.win32,
    commandExists: () => false, fileExists: (file) => file === configPath });
  assert.equal(agent?.configPath, configPath);
  assert.equal(agent?.available, true);
});
