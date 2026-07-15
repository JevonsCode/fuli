import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentCommands,
  connectAgent,
  discoverAgents
} from '../src/setup/agents.js';

const CONTEXT = Object.freeze({
  nodePath: 'C:/Program Files/nodejs/node.exe',
  mcpServerPath: 'C:/Fuli/src/mcp-server.js',
  dbPath: 'C:/Users/Test/Fuli/context.db',
  personalSpaceName: '我'
});

test('agent discovery reports Codex and Claude Code without failing on missing commands', () => {
  const agents = discoverAgents({
    platform: 'win32',
    env: { CODEX_HOME: 'C:/Codex' },
    homeDir: 'C:/Users/Test',
    commandExists: (command) => command === 'claude'
  });

  assert.deepEqual(agents.map(({ id, available }) => ({ id, available })), [
    { id: 'codex', available: false },
    { id: 'claude-code', available: true }
  ]);
  assert.equal(agents[0].configPath, 'C:\\Codex\\config.toml');
  assert.equal(agents[1].configPath, 'C:\\Users\\Test\\.claude.json');
});

test('Codex and Claude Code registrations use their native MCP CLI', () => {
  const [codex, claude] = discoverAgents({
    platform: 'win32',
    env: {},
    homeDir: 'C:/Users/Test',
    commandExists: () => true
  });

  assert.deepEqual(buildAgentCommands(codex, CONTEXT), {
    remove: ['codex', ['mcp', 'remove', 'fuli']],
    add: ['codex', [
      'mcp', 'add', 'fuli', '--', CONTEXT.nodePath, CONTEXT.mcpServerPath,
      '--db', CONTEXT.dbPath, '--personal-space', '我'
    ]]
  });
  assert.deepEqual(buildAgentCommands(claude, CONTEXT), {
    remove: ['claude', ['mcp', 'remove', '--scope', 'user', 'fuli']],
    add: ['claude', [
      'mcp', 'add', '--scope', 'user', 'fuli', '--', CONTEXT.nodePath,
      CONTEXT.mcpServerPath, '--db', CONTEXT.dbPath, '--personal-space', '我'
    ]]
  });
});

test('agent connection tolerates a missing old registration and requires add success', () => {
  const [agent] = discoverAgents({ commandExists: () => true });
  const calls = [];
  const connected = connectAgent(agent, CONTEXT, {
    runCommand(command, args) {
      calls.push([command, args]);
      return { status: calls.length === 1 ? 1 : 0, stderr: '' };
    }
  });

  assert.equal(connected.status, 'connected');
  assert.equal(calls.length, 2);

  assert.throws(() => connectAgent(agent, CONTEXT, {
    runCommand(command, args) {
      return { status: args.includes('add') ? 2 : 0, stderr: 'private config detail' };
    }
  }), /Could not connect Codex to Fuli/);
});
