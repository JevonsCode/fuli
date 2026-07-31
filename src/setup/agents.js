import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  connectClaudeCode,
  disconnectClaudeCode
} from './claude-code-config.js';
import { connectCursor, disconnectCursor } from './cursor-config.js';
import { connectCodex, disconnectCodex } from './codex-config.js';

export function discoverAgents({
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
  fileExists = existsSync,
  commandExists = (command) => defaultCommandExists(command, platform)
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const codexHome = nonEmpty(env.CODEX_HOME) ?? pathApi.join(homeDir, '.codex');
  const skillName = 'capturing-session-knowledge';
  const projectSkillName = 'grilling-project';
  return [
    {
      id: 'codex',
      label: 'Codex',
      command: 'codex',
      configPath: pathApi.join(codexHome, 'config.toml'),
      globalInstructionsPath: pathApi.join(codexHome, 'AGENTS.md'),
      globalInstructionsOverridePath: pathApi.join(codexHome, 'AGENTS.override.md'),
      skillPath: pathApi.join(homeDir, '.agents', 'skills', skillName),
      projectSkillPath: pathApi.join(homeDir, '.agents', 'skills', projectSkillName),
      available: Boolean(commandExists('codex') || fileExists(pathApi.join(codexHome, 'config.toml')))
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      command: 'claude',
      configPath: pathApi.join(homeDir, '.claude.json'),
      settingsPath: pathApi.join(homeDir, '.claude', 'settings.json'),
      skillPath: pathApi.join(homeDir, '.claude', 'skills', skillName),
      projectSkillPath: pathApi.join(homeDir, '.claude', 'skills', projectSkillName),
      available: Boolean(commandExists('claude'))
    },
    {
      id: 'cursor',
      label: 'Cursor',
      command: 'cursor',
      configPath: pathApi.join(homeDir, '.cursor', 'mcp.json'),
      skillPath: pathApi.join(homeDir, '.cursor', 'skills', skillName),
      projectSkillPath: pathApi.join(homeDir, '.cursor', 'skills', projectSkillName),
      available: Boolean(commandExists('cursor'))
    }
  ];
}

export function buildAgentCommands(agent, context) {
  const serverArgs = [
    context.mcpServerPath,
    '--runtime-config',
    context.runtimeConfigPath
  ];
  const mcpArgs = [context.nodePath, ...serverArgs];
  if (agent.id === 'codex') {
    return {
      remove: [agent.command, ['mcp', 'remove', 'fuli']],
      add: [agent.command, ['mcp', 'add', 'fuli', '--', ...mcpArgs]]
    };
  }
  if (agent.id === 'claude-code') {
    return {
      remove: [agent.command, ['mcp', 'remove', '--scope', 'user', 'fuli']],
      add: [agent.command, ['mcp', 'add', '--scope', 'user', 'fuli', '--', ...mcpArgs]]
    };
  }
  throw new TypeError(`Unsupported agent: ${agent.id}`);
}

export function connectAgent(agent, context, {
  runCommand = defaultRunCommand,
  connectCodexConfig = connectCodex,
  connectClaudeCodeConfig = connectClaudeCode,
  connectCursorConfig = connectCursor
} = {}) {
  if (agent.id === 'codex') return connectCodexConfig(agent, context);
  if (agent.id === 'claude-code') {
    return connectClaudeCodeConfig(agent, context);
  }
  if (agent.id === 'cursor') return connectCursorConfig(agent, context);

  const commands = buildAgentCommands(agent, context);
  runCommand(...commands.remove);
  const result = runCommand(...commands.add);
  if (result?.status !== 0) {
    throw new Error(`Could not connect ${agent.label} to Fuli`);
  }
  return { id: agent.id, label: agent.label, status: 'connected' };
}

export function disconnectAgent(agent, {
  disconnectCodexConfig = disconnectCodex,
  disconnectClaudeCodeConfig = disconnectClaudeCode,
  disconnectJsonConfig = disconnectCursor
} = {}) {
  if (agent.id === 'codex') return disconnectCodexConfig(agent);
  if (agent.id === 'claude-code') return disconnectClaudeCodeConfig(agent);
  if (agent.id === 'cursor') {
    return disconnectJsonConfig(agent);
  }
  throw new TypeError(`Unsupported agent: ${agent.id}`);
}

export function defaultCommandExists(command, platform = process.platform) {
  const locator = platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'ignore'
  });
  return result.status === 0;
}

function defaultRunCommand(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe'
  });
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}
