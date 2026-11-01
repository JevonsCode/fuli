import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  connectAgent,
  disconnectAgent,
  agentTargets
} from '../src/setup/agents.js';

const CONTEXT = Object.freeze({
  nodePath: 'C:/Program Files/nodejs/node.exe',
  mcpServerPath: 'C:/Fuli/src/mcp-server.js',
  runtimeConfigPath: 'C:/Users/Test/Fuli/graph-runtime.json'
});

test('writer targets name where Codex, Claude Code and Cursor are edited, whatever is installed', () => {
  const agents = agentTargets({
    platform: 'win32',
    env: { CODEX_HOME: 'C:/Codex' },
    homeDir: 'C:/Users/Test',
    fileExists: () => false,
    commandVersion: () => null
  });

  assert.deepEqual(agents.slice(0, 3).map(({ id }) => id), ['codex', 'claude-code', 'cursor']);
  assert.equal(agents.some((agent) => 'available' in agent), false, 'agent-installer says which clients are installed');
  assert.equal(agents[0].configPath, 'C:\\Codex\\config.toml');
  assert.equal(agents[0].globalInstructionsPath, 'C:\\Codex\\AGENTS.md');
  assert.equal(agents[0].globalInstructionsOverridePath, 'C:\\Codex\\AGENTS.override.md');
  assert.equal(agents[0].skillPath, 'C:\\Users\\Test\\.agents\\skills\\capturing-session-knowledge');
  assert.equal(agents[0].projectSkillPath, 'C:\\Users\\Test\\.agents\\skills\\grilling-project');
  assert.equal(agents[0].reviewSkillPath, 'C:\\Users\\Test\\.agents\\skills\\flreview');
  assert.equal(agents[0].operationSkillPath, 'C:\\Users\\Test\\.agents\\skills\\operating-fuli');
  assert.equal(agents[0].sessionCommandSkillPath, undefined);
  assert.equal(agents[1].configPath, 'C:\\Users\\Test\\.claude.json');
  assert.match(agents[1].settingsPath, /\\\.claude\\settings\.json$/);
  assert.equal(agents[1].skillPath, 'C:\\Users\\Test\\.claude\\skills\\capturing-session-knowledge');
  assert.equal(agents[1].projectSkillPath, 'C:\\Users\\Test\\.claude\\skills\\grilling-project');
  assert.equal(agents[1].reviewSkillPath, 'C:\\Users\\Test\\.claude\\skills\\flreview');
  assert.equal(agents[1].operationSkillPath, 'C:\\Users\\Test\\.claude\\skills\\operating-fuli');
  assert.equal(agents[1].sessionCommandSkillPath, 'C:\\Users\\Test\\.claude\\skills\\fuli');
  assert.equal(agents[2].configPath, 'C:\\Users\\Test\\.cursor\\mcp.json');
  assert.equal(agents[2].skillPath, 'C:\\Users\\Test\\.cursor\\skills\\capturing-session-knowledge');
  assert.equal(agents[2].projectSkillPath, 'C:\\Users\\Test\\.cursor\\skills\\grilling-project');
  assert.equal(agents[2].reviewSkillPath, 'C:\\Users\\Test\\.cursor\\skills\\flreview');
  assert.equal(agents[2].operationSkillPath, 'C:\\Users\\Test\\.cursor\\skills\\operating-fuli');
  assert.equal(agents[2].sessionCommandSkillPath, 'C:\\Users\\Test\\.cursor\\skills\\fuli');
});

test('Claude connection delegates to its lifecycle-aware config connector', () => {
  const agent = agentTargets({ commandVersion: () => null })[1];
  const calls = [];
  const connected = connectAgent(agent, CONTEXT, {
    connectConfig(selectedAgent, context) {
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
  const codex = agentTargets({ commandVersion: () => null })[0];
  const calls = [];
  const connected = connectAgent(codex, CONTEXT, {
    connectConfig(agent, context) {
      calls.push([agent, context]);
      return { id: agent.id, label: agent.label, status: 'connected' };
    }
  });

  assert.equal(connected.status, 'connected');
  assert.deepEqual(calls, [[codex, CONTEXT]]);
});

test('Cursor connection delegates to its JSON config connector', () => {
  const cursor = agentTargets({ commandVersion: () => null })[2];
  const calls = [];
  const connected = connectAgent(cursor, CONTEXT, {
    connectConfig(agent, context) {
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
  const claude = agentTargets({ commandVersion: () => null })[1];
  const calls = [];
  const result = disconnectAgent(claude, {
    disconnectConfig(agent) {
      calls.push(agent);
      return { id: agent.id, label: agent.label, status: 'disconnected' };
    }
  });

  assert.equal(result.status, 'disconnected');
  assert.deepEqual(calls, [claude]);
});

// The real probe against a synthetic `opencode` on PATH that prints what
// OpenCode 2.1.4 prints. No real OpenCode or home directory is touched.
test('the OpenCode target reads OpenCode\'s real `opencode v2.1.4` version line', (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'p63-opencode-bin-'));
  const home = mkdtempSync(join(tmpdir(), 'p63-opencode-home-'));
  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  if (process.platform === 'win32') writeFileSync(join(bin, 'opencode.cmd'), '@echo opencode v2.1.4\r\n');
  else writeFileSync(join(bin, 'opencode'), '#!/bin/sh\nprintf "opencode v2.1.4\n"\n', { mode: 0o755 });
  process.env.PATH = `${bin}${delimiter}${path}`;
  const agent = agentTargets({ homeDir: home, env: {} }).find(({ id }) => id === 'opencode');
  assert.equal(agent.clientVersion, '2.1.4');
});
