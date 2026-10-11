import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  connectClaudeCode,
  disconnectClaudeCode
} from './claude-code-config.js';
import { connectClaudeDesktop, disconnectClaudeDesktop } from './claude-desktop-config.js';
import { connectCursor, disconnectCursor } from './cursor-config.js';
import { connectCodex, disconnectCodex } from './codex-config.js';
import { adaptAgentForReviewSkill } from './review-skill-adapters.js';

export function discoverAgents({
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
  fileExists = existsSync,
  commandExists = (command) => defaultCommandExists(command, platform)
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const codexHome = nonEmpty(env.CODEX_HOME) ?? pathApi.join(homeDir, '.codex');
  const claudeHome = pathApi.join(homeDir, '.claude');
  const cursorHome = pathApi.join(homeDir, '.cursor');
  const skillName = 'capturing-session-knowledge';
  const projectSkillName = 'grilling-project';
  const operationSkillName = 'operating-fuli';
  return [
    {
      id: 'codex',
      label: 'Codex',
      command: 'codex',
      configPath: pathApi.join(codexHome, 'config.toml'),
      hooksPath: pathApi.join(codexHome, 'hooks.json'),
      globalInstructionsPath: pathApi.join(codexHome, 'AGENTS.md'),
      globalInstructionsOverridePath: pathApi.join(codexHome, 'AGENTS.override.md'),
      skillPath: pathApi.join(homeDir, '.agents', 'skills', skillName),
      projectSkillPath: pathApi.join(homeDir, '.agents', 'skills', projectSkillName),
      operationSkillPath: pathApi.join(homeDir, '.agents', 'skills', operationSkillName),
      available: Boolean(commandExists('codex') || fileExists(pathApi.join(codexHome, 'config.toml')))
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      command: 'claude',
      configPath: pathApi.join(homeDir, '.claude.json'),
      settingsPath: pathApi.join(claudeHome, 'settings.json'),
      skillPath: pathApi.join(claudeHome, 'skills', skillName),
      projectSkillPath: pathApi.join(claudeHome, 'skills', projectSkillName),
      operationSkillPath: pathApi.join(claudeHome, 'skills', operationSkillName),
      available: Boolean(
        commandExists('claude') ||
        fileExists(pathApi.join(homeDir, '.claude.json')) ||
        fileExists(claudeHome)
      )
    },
    {
      id: 'cursor',
      label: 'Cursor',
      command: 'cursor',
      configPath: pathApi.join(cursorHome, 'mcp.json'),
      hooksPath: pathApi.join(cursorHome, 'hooks.json'),
      skillPath: pathApi.join(cursorHome, 'skills', skillName),
      projectSkillPath: pathApi.join(cursorHome, 'skills', projectSkillName),
      operationSkillPath: pathApi.join(cursorHome, 'skills', operationSkillName),
      available: Boolean(
        commandExists('cursor') ||
        fileExists(pathApi.join(cursorHome, 'mcp.json')) ||
        fileExists(cursorHome)
      )
    }
  ].map((agent) => adaptAgentForReviewSkill(agent, { homeDir, pathApi }))
    .concat(claudeDesktop({ platform, env, homeDir, pathApi, fileExists }) ?? []);
}

// The chat app: MCP only, no hooks or Skills. Its config lives beside its app data.
function claudeDesktop({ platform, env, homeDir, pathApi, fileExists }) {
  const appData = platform === 'win32' ? nonEmpty(env.APPDATA)
    : platform === 'darwin' ? pathApi.join(homeDir, 'Library', 'Application Support') : null;
  if (!appData) return null;
  const configDir = pathApi.join(appData, 'Claude');
  return {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    configPath: pathApi.join(configDir, 'claude_desktop_config.json'),
    available: Boolean(fileExists(configDir))
  };
}

export function connectAgent(agent, context, {
  connectCodexConfig = connectCodex,
  connectClaudeCodeConfig = connectClaudeCode,
  connectCursorConfig = connectCursor,
  connectClaudeDesktopConfig = connectClaudeDesktop
} = {}) {
  if (agent.id === 'codex') return connectCodexConfig(agent, context);
  if (agent.id === 'claude-code') {
    return connectClaudeCodeConfig(agent, context);
  }
  if (agent.id === 'cursor') return connectCursorConfig(agent, context);
  if (agent.id === 'claude-desktop') return connectClaudeDesktopConfig(agent, context);
  throw new TypeError(`Unsupported agent: ${agent.id}`);
}

export function disconnectAgent(agent, {
  disconnectCodexConfig = disconnectCodex,
  disconnectClaudeCodeConfig = disconnectClaudeCode,
  disconnectJsonConfig = disconnectCursor,
  disconnectClaudeDesktopConfig = disconnectClaudeDesktop
} = {}) {
  if (agent.id === 'codex') return disconnectCodexConfig(agent);
  if (agent.id === 'claude-code') return disconnectClaudeCodeConfig(agent);
  if (agent.id === 'cursor') {
    return disconnectJsonConfig(agent);
  }
  if (agent.id === 'claude-desktop') return disconnectClaudeDesktopConfig(agent);
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

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}
