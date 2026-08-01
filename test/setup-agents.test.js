import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentCommands,
  connectAgent,
  disconnectAgent,
  discoverAgents
} from '../src/setup/agents.js';

const CONTEXT = Object.freeze({
  nodePath: 'C:/Program Files/nodejs/node.exe',
  mcpServerPath: 'C:/Fuli/src/mcp-server.js',
  runtimeConfigPath: 'C:/Users/Test/Fuli/graph-runtime.json'
});

test('agent discovery reports Codex, Claude Code, and Cursor without failing on missing commands', () => {
  const agents = discoverAgents({
    platform: 'win32',
    env: { CODEX_HOME: 'C:/Codex' },
    homeDir: 'C:/Users/Test',
    commandExists: (command) => command === 'claude'
  });

  assert.deepEqual(agents.map(({ id, available }) => ({ id, available })), [
    { id: 'codex', available: false },
    { id: 'claude-code', available: true },
    { id: 'cursor', available: false }
  ]);
  assert.equal(agents[0].configPath, 'C:\\Codex\\config.toml');
  assert.equal(agents[0].globalInstructionsPath, 'C:\\Codex\\AGENTS.md');
  assert.equal(agents[0].globalInstructionsOverridePath, 'C:\\Codex\\AGENTS.override.md');
  assert.equal(agents[0].skillPath, 'C:\\Users\\Test\\.agents\\skills\\capturing-session-knowledge');
  assert.equal(agents[0].projectSkillPath, 'C:\\Users\\Test\\.agents\\skills\\grilling-project');
  assert.equal(agents[0].reviewSkillPath, 'C:\\Users\\Test\\.agents\\skills\\flreview');
  assert.equal(agents[1].configPath, 'C:\\Users\\Test\\.claude.json');
  assert.match(agents[1].settingsPath, /\\\.claude\\settings\.json$/);
  assert.equal(agents[1].skillPath, 'C:\\Users\\Test\\.claude\\skills\\capturing-session-knowledge');
  assert.equal(agents[1].projectSkillPath, 'C:\\Users\\Test\\.claude\\skills\\grilling-project');
  assert.equal(agents[1].reviewSkillPath, 'C:\\Users\\Test\\.claude\\skills\\flreview');
  assert.equal(agents[2].configPath, 'C:\\Users\\Test\\.cursor\\mcp.json');
  assert.equal(agents[2].skillPath, 'C:\\Users\\Test\\.cursor\\skills\\capturing-session-knowledge');
  assert.equal(agents[2].projectSkillPath, 'C:\\Users\\Test\\.cursor\\skills\\grilling-project');
  assert.equal(agents[2].reviewSkillPath, 'C:\\Users\\Test\\.cursor\\skills\\flreview');
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
      '--runtime-config', CONTEXT.runtimeConfigPath
    ]]
  });
  assert.deepEqual(buildAgentCommands(claude, CONTEXT), {
    remove: ['claude', ['mcp', 'remove', '--scope', 'user', 'fuli']],
    add: ['claude', [
      'mcp', 'add', '--scope', 'user', 'fuli', '--', CONTEXT.nodePath,
      CONTEXT.mcpServerPath, '--runtime-config', CONTEXT.runtimeConfigPath
    ]]
  });
});

test('Claude connection delegates to its lifecycle-aware config connector', () => {
  const agent = discoverAgents({ commandExists: () => true })[1];
  const calls = [];
  const connected = connectAgent(agent, CONTEXT, {
    connectClaudeCodeConfig(selectedAgent, context) {
      calls.push([selectedAgent, context]);
      return {
        id: selectedAgent.id,
        label: selectedAgent.label,
        status: 'connected',
        newTaskRequired: true
      };
    }
  });

  assert.equal(connected.status, 'connected');
  assert.equal(connected.newTaskRequired, true);
  assert.deepEqual(calls, [[agent, CONTEXT]]);
});

test('Codex connection delegates to its shared config connector', () => {
  const codex = discoverAgents({ commandExists: () => true })[0];
  const calls = [];
  const connected = connectAgent(codex, CONTEXT, {
    connectCodexConfig(agent, context) {
      calls.push([agent, context]);
      return { id: agent.id, label: agent.label, status: 'connected' };
    }
  });

  assert.equal(connected.status, 'connected');
  assert.deepEqual(calls, [[codex, CONTEXT]]);
});

test('Cursor connection delegates to its JSON config connector', () => {
  const cursor = discoverAgents({ commandExists: () => true })[2];
  const calls = [];
  const connected = connectAgent(cursor, CONTEXT, {
    connectCursorConfig(agent, context) {
      calls.push([agent, context]);
      return { id: agent.id, label: agent.label, status: 'connected' };
    }
  });

  assert.equal(connected.status, 'connected');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], cursor);
  assert.equal(calls[0][1], CONTEXT);
});

test('Claude disconnect removes only its Fuli JSON registration', () => {
  const claude = discoverAgents({ commandExists: () => true })[1];
  const calls = [];
  const result = disconnectAgent(claude, {
    disconnectClaudeCodeConfig(agent) {
      calls.push(agent);
      return { id: agent.id, label: agent.label, status: 'disconnected' };
    }
  });

  assert.equal(result.status, 'disconnected');
  assert.deepEqual(calls, [claude]);
});
