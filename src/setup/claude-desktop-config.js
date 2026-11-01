import { existsSync } from 'node:fs';

import { installedToolProfile } from './installed-tool-profile.js';

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { assertJsonObject } from '../validation/values.js';

// Arguments after the runtime config that identify the app and keep its tool list small.
const CLAUDE_DESKTOP_SERVER_ARGS = Object.freeze(['--source-application', 'claude', '--tool-profile', 'chat']);

// Claude Desktop (the chat app) reads stdio MCP servers from
// claude_desktop_config.json. It has no lifecycle hooks or Skill folder, and it
// loads every tool schema into each chat, so it gets the compact chat profile.
export function connectClaudeDesktop(agent, context, {
  readConfig = readJsonFile,
  writeConfig = writeJsonFileAtomic
} = {}) {
  const current = readConfig(agent.configPath, {});
  assertJsonObject(current, 'Claude Desktop config');
  const currentServers = current.mcpServers ?? {};
  assertJsonObject(currentServers, 'Claude Desktop mcpServers');
  const next = {
    ...current,
    mcpServers: {
      ...currentServers,
      fuli: {
        command: context.nodePath,
        args: [
          context.mcpServerPath,
          '--runtime-config',
          context.runtimeConfigPath,
          ...CLAUDE_DESKTOP_SERVER_ARGS.slice(0, -1),
          installedToolProfile(currentServers.fuli?.args, context.toolProfile)
        ]
      }
    }
  };
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) writeConfig(agent.configPath, next);
  // The app only reads its config at launch.
  return { id: agent.id, label: agent.label, status: 'connected', restartRequired: changed };
}

export function disconnectClaudeDesktop(agent, {
  fileExists = existsSync,
  readConfig = readJsonFile,
  writeConfig = writeJsonFileAtomic
} = {}) {
  if (!fileExists(agent.configPath)) return { id: agent.id, label: agent.label, status: 'not_connected' };
  const current = readConfig(agent.configPath, {});
  assertJsonObject(current, 'Claude Desktop config');
  const currentServers = current.mcpServers ?? {};
  assertJsonObject(currentServers, 'Claude Desktop mcpServers');
  if (!Object.hasOwn(currentServers, 'fuli')) return { id: agent.id, label: agent.label, status: 'not_connected' };
  const { fuli: _removed, ...remainingServers } = currentServers;
  writeConfig(agent.configPath, { ...current, mcpServers: remainingServers });
  return { id: agent.id, label: agent.label, status: 'disconnected' };
}
