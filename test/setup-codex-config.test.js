import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connectCodex,
  disconnectCodex,
  removeFuliTables,
  replaceFuliTable
} from '../src/setup/codex-config.js';

const AGENT = Object.freeze({
  id: 'codex', label: 'Codex', configPath: '/user/.codex/config.toml'
});
const CONTEXT = Object.freeze({
  nodePath: '/runtime/node',
  mcpServerPath: '/package/src/mcp-server.js',
  runtimeConfigPath: '/data/graph-runtime.json'
});

test('Codex config preserves unrelated settings and replaces all old Fuli tables', () => {
  const current = [
    'model = "gpt-current"',
    '',
    '[mcp_servers.fuli]',
    'command = "old"',
    '',
    '[mcp_servers.fuli.env]',
    'OLD = "value"',
    '',
    '[mcp_servers.other]',
    'command = "other"',
    ''
  ].join('\n');
  const next = replaceFuliTable(current, {
    command: CONTEXT.nodePath,
    args: [CONTEXT.mcpServerPath, '--runtime-config', CONTEXT.runtimeConfigPath]
  });

  assert.match(next, /model = "gpt-current"/);
  assert.match(next, /\[mcp_servers\.other]/);
  assert.equal((next.match(/\[mcp_servers\.fuli]/g) ?? []).length, 1);
  assert.doesNotMatch(next, /OLD|command = "old"/);
  assert.match(next, /required = true/);
  assert.match(next, /--runtime-config/);
});

test('Codex connector writes the merged user config', () => {
  let write;
  const result = connectCodex(AGENT, CONTEXT, {
    readConfig: () => 'approval_policy = "on-request"\n',
    writeConfig: (path, value) => { write = { path, value }; }
  });

  assert.deepEqual(result, {
    id: 'codex',
    label: 'Codex',
    status: 'connected',
    newTaskRequired: true
  });
  assert.equal(write.path, AGENT.configPath);
  assert.match(write.value, /approval_policy = "on-request"/);
  assert.match(write.value, /command = "\/runtime\/node"/);
  assert.match(write.value, /"--source-application", "codex"/);
});

test('Codex connector avoids rewriting a current config and reports no reload', () => {
  const current = replaceFuliTable('', {
    command: CONTEXT.nodePath,
    args: [
      CONTEXT.mcpServerPath,
      '--runtime-config',
      CONTEXT.runtimeConfigPath,
      '--source-application',
      'codex'
    ]
  });
  let writes = 0;
  const result = connectCodex(AGENT, CONTEXT, {
    readConfig: () => current,
    writeConfig: () => { writes += 1; },
    installBootstrap: () => ({ changed: false })
  });

  assert.equal(writes, 0);
  assert.equal(result.newTaskRequired, false);
});

test('Codex disconnect removes only Fuli tables and keeps unrelated settings', () => {
  const current = [
    'model = "gpt-current"',
    '',
    '[mcp_servers.fuli]',
    'command = "node"',
    '',
    '[mcp_servers.fuli.env]',
    'TOKEN = "not-copied"',
    '',
    '[mcp_servers.other]',
    'command = "other"',
    ''
  ].join('\n');
  const next = removeFuliTables(current);
  assert.match(next, /model = "gpt-current"/);
  assert.match(next, /\[mcp_servers\.other]/);
  assert.doesNotMatch(next, /mcp_servers\.fuli|TOKEN/);

  let write = null;
  const result = disconnectCodex(AGENT, {
    fileExists: () => true,
    readConfig: () => current,
    writeConfig: (path, value) => { write = { path, value }; }
  });
  assert.equal(result.status, 'disconnected');
  assert.equal(write.path, AGENT.configPath);
  assert.equal(write.value, next);
});
